import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { getRepository } from '$lib/server/data';
import { requireRole } from '$lib/server/auth-guard';
import { getDb } from '$lib/server/db/client';
import { upsertOntologyMeta } from '$lib/server/ontology/load';

const ONTOLOGY_LABELS: Record<string, string> = {
	mesh: 'MeSH',
	mondo: 'Mondo Disease Ontology',
	hpo: 'Human Phenotype Ontology',
	rxnorm: 'RxNorm',
	umls: 'UMLS (user-supplied)',
	snomed: 'SNOMED CT (user-supplied)',
	custom: 'Custom'
};

function slug(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 40);
}

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

const createSchema = z.strictObject({
	name: z.string().trim().min(1).max(120),
	/**
	 * Optional slug to group concepts under (concepts.ontology). Defaults to a
	 * slug of the name; reserved standard slugs are rejected so a custom ontology
	 * never shadows MeSH/Mondo/etc.
	 */
	slug: z.string().trim().min(1).max(40).optional(),
	description: z.string().trim().max(2000).optional()
});

const RESERVED_SLUGS = new Set(['mesh', 'mondo', 'hpo', 'rxnorm', 'umls', 'snomed']);

/**
 * POST /api/ontologies (admin) — create an empty, named custom ontology (A11).
 * Persists an `ontologies` metadata row (status='draft', 0 concepts) surfaced by
 * the admin grid; concepts are added later via the Import modal or concept CRUD.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const user = requireRole(locals.user, 'admin');
	const orgId = user.orgId || 'org_1';

	const db = getDb();
	if (!db) throw error(503, 'Ontology writes require the database');

	const parsed = createSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		throw error(400, `Invalid ontology body${first ? `: ${first.path.join('.')} ${first.message}` : ''}`);
	}

	const desired = slug(parsed.data.slug ?? parsed.data.name) || 'custom';
	if (RESERVED_SLUGS.has(desired)) {
		throw error(409, `"${desired}" is a reserved standard ontology slug — choose another name/slug`);
	}

	const id = await upsertOntologyMeta(orgId, desired, { name: parsed.data.name, status: 'draft' });
	return json(
		{ id, ontology: desired, name: parsed.data.name, entities: 0, relations: 0, status: 'draft' },
		{ status: 201 }
	);
};
