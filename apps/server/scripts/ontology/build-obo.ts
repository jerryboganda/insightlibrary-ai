/**
 * Build a full ontology from an OBO Graph JSON release into the loader format
 * (resources/ontologies/<name>.json). Works for the freely-redistributable
 * Mondo and HPO releases (OBO Graph JSON). MeSH (XML) and RxNorm (RRF) use
 * different source formats — write a sibling parser emitting the same shape.
 *
 * Usage:
 *   tsx scripts/ontology/build-obo.ts mondo https://purl.obolibrary.org/obo/mondo.json
 *   tsx scripts/ontology/build-obo.ts hpo   https://purl.obolibrary.org/obo/hp.json
 * Then:
 *   pnpm db:ontology:load resources/ontologies/mondo.json
 *
 * UMLS / SNOMED are license-gated and must NOT be bundled — load a user-supplied
 * copy locally with the same converter pattern.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function idOf(iri: string, ontology: string): { code: string; id: string } {
	const seg = iri.split('/').pop() ?? iri;
	const code = seg.replace('_', ':'); // MONDO_0008170 → MONDO:0008170
	return { code, id: `${ontology}:${code}` };
}

async function main() {
	const [ontology, url, outArg] = process.argv.slice(2);
	if (!ontology || !url) {
		console.error('usage: build-obo.ts <ontology> <oboGraphJsonUrl> [outPath]');
		process.exit(1);
	}
	console.log(`Fetching ${url} …`);
	const res = await fetch(url);
	if (!res.ok) {
		console.error(`fetch failed: ${res.status}`);
		process.exit(1);
	}
	const doc = (await res.json()) as { graphs?: { nodes?: any[]; edges?: any[] }[] };
	const graph = doc.graphs?.[0] ?? { nodes: [], edges: [] };

	const inOnt = new Set<string>();
	const concepts: any[] = [];
	for (const n of graph.nodes ?? []) {
		if (!n.id || !n.lbl) continue;
		if (n.type && n.type !== 'CLASS') continue;
		const { code, id } = idOf(n.id, ontology);
		if (!code.includes(':')) continue;
		inOnt.add(n.id);
		const syns = ((n.meta?.synonyms ?? []) as any[]).map((s) => s.val).filter(Boolean);
		concepts.push({
			id,
			ontology,
			code,
			prefLabel: n.lbl,
			kind: 'concept',
			description: n.meta?.definition?.val ?? '',
			synonyms: [...new Set(syns)]
		});
	}

	const edges: any[] = [];
	for (const e of graph.edges ?? []) {
		const isa = e.pred === 'is_a' || (typeof e.pred === 'string' && e.pred.endsWith('subClassOf'));
		if (!isa || !inOnt.has(e.sub) || !inOnt.has(e.obj)) continue;
		edges.push({ source: idOf(e.sub, ontology).id, target: idOf(e.obj, ontology).id, rel: 'is_a' });
	}

	const out = outArg ?? join('resources', 'ontologies', `${ontology}.json`);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, JSON.stringify({ concepts, edges }, null, 2));
	console.log(`Wrote ${concepts.length} concepts + ${edges.length} edges → ${out}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
