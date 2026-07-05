import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { getRepository } from '$lib/server/data';
import { getCommunities } from '$lib/server/graph/community';

/**
 * GET /api/graph/stats — cheap knowledge-graph rollups (node/edge/community
 * counts + top groups) so dashboards stop downloading the entire graph just to
 * render a KPI. Node/edge counts are single SQL aggregates; the community
 * count reuses the union-find the communities endpoint already runs.
 */
export const GET: RequestHandler = async ({ locals }) => {
	const orgId = locals.user?.orgId || 'org_1';
	const db = getDb();

	if (!db) {
		// Memory mode: seed graph counts + a tiny connected-components pass.
		const graph = await getRepository().getGraph();
		const parent = new Map<string, string>();
		const find = (x: string): string => {
			if (!parent.has(x)) parent.set(x, x);
			let r = x;
			while (parent.get(r) !== r) r = parent.get(r) as string;
			parent.set(x, r);
			return r;
		};
		for (const n of graph.nodes) find(n.id);
		for (const e of graph.edges) parent.set(find(e.source), find(e.target));
		const sizes = new Map<string, number>();
		for (const n of graph.nodes) {
			const r = find(n.id);
			sizes.set(r, (sizes.get(r) ?? 0) + 1);
		}
		const communities = [...sizes.values()].filter((s) => s >= 2).length;
		return json({
			source: 'memory',
			nodes: graph.nodes.length,
			edges: graph.edges.length,
			communities,
			groups: []
		});
	}

	const nodeRes = await db.execute<{ n: number }>(
		sql`SELECT COUNT(*)::int AS n FROM graph_nodes WHERE org_id = ${orgId}`
	);
	const edgeRes = await db.execute<{ n: number }>(
		sql`SELECT COUNT(*)::int AS n FROM graph_edges WHERE org_id = ${orgId}`
	);
	const groupRes = await db.execute<{ grp: string; n: number }>(sql`
		SELECT "group" AS grp, COUNT(*)::int AS n
		FROM graph_nodes WHERE org_id = ${orgId}
		GROUP BY "group" ORDER BY n DESC LIMIT 10
	`);
	// Connected components over the org graph (same computation the communities
	// endpoint performs); degrade to null rather than failing the cheap counts.
	const communities = await getCommunities(orgId)
		.then((c) => c.length)
		.catch(() => null);

	return json({
		source: 'postgres',
		nodes: Number(nodeRes.rows[0]?.n ?? 0),
		edges: Number(edgeRes.rows[0]?.n ?? 0),
		communities,
		groups: groupRes.rows.map((r) => ({ group: r.grp, count: Number(r.n) }))
	});
};
