/**
 * GraphRAG community detection (connected components via union-find over the
 * semantic knowledge graph) + community summaries for dual-level ("global")
 * retrieval. Computed on demand — no schema change. Worker/route safe.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { graphEdges, graphNodes } from '../db/schema';
import { getRouter } from '../ai/providers';

export interface Community {
	id: string;
	label: string;
	size: number;
	nodeIds: string[];
}

class UnionFind {
	private parent = new Map<string, string>();
	find(x: string): string {
		if (!this.parent.has(x)) this.parent.set(x, x);
		let r = x;
		while (this.parent.get(r) !== r) r = this.parent.get(r) as string;
		let c = x;
		while (this.parent.get(c) !== r) {
			const n = this.parent.get(c) as string;
			this.parent.set(c, r);
			c = n;
		}
		return r;
	}
	union(a: string, b: string): void {
		const ra = this.find(a);
		const rb = this.find(b);
		if (ra !== rb) this.parent.set(ra, rb);
	}
}

async function loadGraph(orgId: string) {
	const db = getDb();
	if (!db) return null;
	const nodes = await db.select().from(graphNodes).where(eq(graphNodes.orgId, orgId));
	const edges = await db.select().from(graphEdges).where(eq(graphEdges.orgId, orgId));
	return { nodes, edges };
}

export async function getCommunities(orgId = 'org_1'): Promise<Community[]> {
	const g = await loadGraph(orgId);
	if (!g) return [];
	const uf = new UnionFind();
	const labelById = new Map<string, string>();
	const degree = new Map<string, number>();
	for (const n of g.nodes) {
		uf.find(n.id);
		labelById.set(n.id, n.label || n.id);
	}
	for (const e of g.edges) {
		uf.union(e.source, e.target);
		degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
		degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
	}
	const groups = new Map<string, string[]>();
	for (const n of g.nodes) {
		const r = uf.find(n.id);
		const list = groups.get(r) ?? [];
		list.push(n.id);
		groups.set(r, list);
	}
	const communities: Community[] = [];
	let idx = 0;
	for (const ids of groups.values()) {
		if (ids.length < 2) continue;
		idx++;
		let best = ids[0];
		let bd = -1;
		for (const id of ids) {
			const d = degree.get(id) ?? 0;
			if (d > bd) {
				bd = d;
				best = id;
			}
		}
		communities.push({ id: `c${idx}`, label: labelById.get(best) ?? best, size: ids.length, nodeIds: ids });
	}
	communities.sort((a, b) => b.size - a.size);
	return communities;
}

export interface CommunityDetail {
	label: string;
	nodes: { id: string; label: string }[];
	edges: { source: string; target: string; label: string }[];
	summary?: string;
}

export async function getCommunityForNode(orgId: string, nodeId: string): Promise<CommunityDetail | null> {
	const g = await loadGraph(orgId);
	if (!g || !g.nodes.some((n) => n.id === nodeId)) return null;
	const uf = new UnionFind();
	for (const n of g.nodes) uf.find(n.id);
	for (const e of g.edges) uf.union(e.source, e.target);
	const root = uf.find(nodeId);
	const members = new Set(g.nodes.filter((n) => uf.find(n.id) === root).map((n) => n.id));
	const nodes = g.nodes.filter((n) => members.has(n.id)).map((n) => ({ id: n.id, label: n.label || n.id }));
	const edges = g.edges
		.filter((e) => members.has(e.source) && members.has(e.target))
		.map((e) => ({ source: e.source, target: e.target, label: e.label }));

	const labelOf = (id: string) => nodes.find((n) => n.id === id)?.label ?? id;
	let summary: string | undefined;
	const router = getRouter();
	if (router.available('synthesis') && edges.length) {
		const rels = edges.slice(0, 60).map((e) => `${labelOf(e.source)} --${e.label}--> ${labelOf(e.target)}`).join('\n');
		summary = await router
			.complete([{ role: 'user', content: `Summarize this medical knowledge sub-graph in 2-3 sentences:\n${rels}` }], {
				task: 'synthesis',
				temperature: 0.2,
				maxTokens: 200
			})
			.catch(() => undefined);
	}
	return { label: nodes[0]?.label ?? nodeId, nodes, edges, summary };
}

/** Global (community-level) context for broad "give me everything about X" queries. */
export async function retrieveGlobalContext(orgId: string, limit = 6): Promise<string[]> {
	const communities = await getCommunities(orgId);
	return communities.slice(0, limit).map((c) => `${c.label} (${c.size} concepts)`);
}

/**
 * PageRank over the knowledge graph (the Postgres substitute for CozoDB's graph
 * algorithms). Surfaces the most central concepts for global GraphRAG ranking.
 */
export async function getPageRank(orgId = 'org_1', iterations = 20): Promise<{ id: string; label: string; score: number }[]> {
	const g = await loadGraph(orgId);
	if (!g || !g.nodes.length) return [];
	const ids = g.nodes.map((n) => n.id);
	const labelById = new Map(g.nodes.map((n) => [n.id, n.label || n.id]));
	const outLinks = new Map<string, string[]>(ids.map((id) => [id, []]));
	for (const e of g.edges) outLinks.get(e.source)?.push(e.target);

	const N = ids.length;
	const d = 0.85;
	let pr = new Map<string, number>(ids.map((id) => [id, 1 / N]));
	for (let it = 0; it < iterations; it++) {
		const next = new Map<string, number>(ids.map((id) => [id, (1 - d) / N]));
		let dangling = 0;
		for (const id of ids) if (outLinks.get(id)!.length === 0) dangling += pr.get(id)!;
		for (const id of ids) {
			const outs = outLinks.get(id)!;
			if (!outs.length) continue;
			const share = (d * pr.get(id)!) / outs.length;
			for (const t of outs) if (next.has(t)) next.set(t, next.get(t)! + share);
		}
		const add = (d * dangling) / N;
		for (const id of ids) next.set(id, next.get(id)! + add);
		pr = next;
	}
	return ids
		.map((id) => ({ id, label: labelById.get(id)!, score: pr.get(id)! }))
		.sort((a, b) => b.score - a.score);
}
