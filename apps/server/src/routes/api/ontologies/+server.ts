import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sql } from 'drizzle-orm';
import { getRepository } from '$lib/server/data';
import { getDb } from '$lib/server/db/client';

const ONTOLOGY_LABELS: Record<string, string> = {
	mesh: 'MeSH',
	mondo: 'Mondo Disease Ontology',
	hpo: 'Human Phenotype Ontology',
	rxnorm: 'RxNorm',
	umls: 'UMLS (user-supplied)',
	snomed: 'SNOMED CT (user-supplied)',
	custom: 'Custom'
};

/**
 * GET /api/ontologies — real per-ontology concept + synonym counts from the
 * loaded concept dictionary; falls back to the legacy metadata table when no
 * concepts have been loaded yet.
 */
export const GET: RequestHandler = async () => {
	const db = getDb();
	if (db) {
		const rows = await db.execute<{ ontology: string; entities: number; relations: number }>(sql`
			SELECT c.ontology,
			       count(DISTINCT c.id)::int AS entities,
			       count(s.id)::int AS relations
			FROM concepts c
			LEFT JOIN concept_synonyms s ON s.concept_id = c.id
			GROUP BY c.ontology
			ORDER BY c.ontology
		`);
		if (rows.rows.length) {
			const items = rows.rows.map((r) => ({
				id: `ont_${r.ontology}`,
				name: ONTOLOGY_LABELS[r.ontology] ?? r.ontology.toUpperCase(),
				entities: Number(r.entities),
				relations: Number(r.relations),
				status: 'active' as const,
				lastUpdated: new Date().toISOString()
			}));
			return json({ items, total: items.length });
		}
	}
	const items = await getRepository().listOntologies();
	return json({ items, total: items.length });
};
