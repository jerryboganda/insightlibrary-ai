import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, eq, inArray, or } from 'drizzle-orm';
import { requireRole } from '$lib/server/auth-guard';
import { getDb } from '$lib/server/db/client';
import {
	conceptEdges,
	conceptEmbeddings,
	conceptSynonyms,
	concepts,
	ontologies
} from '$lib/server/db/schema';
import { ontologySchemas } from '$lib/server/ontology/schema-store';
import { ontologySlugFromId, conceptCounts } from '$lib/server/ontology/load';

/**
 * DELETE /api/ontologies/[id] (admin) — remove an ontology (A11): all concepts
 * for its slug (with dependent synonyms/embeddings/edges) plus the editable
 * schema overlay and the metadata row. The concept dictionary is shared (not
 * org-scoped), so this deletes concepts by slug for everyone — intended for
 * custom ontologies an admin uploaded, not the bundled standards.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	const user = requireRole(locals.user, 'admin');
	const orgId = user.orgId || 'org_1';

	const db = getDb();
	if (!db) throw error(503, 'Ontology writes require the database');

	const ontology = ontologySlugFromId(params.id);
	const before = await conceptCounts(ontology);

	// Concept ids for this slug drive the dependent-row deletes.
	const rows = await db.select({ id: concepts.id }).from(concepts).where(eq(concepts.ontology, ontology));
	const ids = rows.map((r) => r.id);

	if (ids.length) {
		// Order matters: children before parents (FKs). Edges reference concepts on
		// both ends; delete any edge touching a removed concept.
		await db
			.delete(conceptEdges)
			.where(or(inArray(conceptEdges.sourceConceptId, ids), inArray(conceptEdges.targetConceptId, ids)));
		await db.delete(conceptEmbeddings).where(inArray(conceptEmbeddings.conceptId, ids));
		await db.delete(conceptSynonyms).where(inArray(conceptSynonyms.conceptId, ids));
		await db.delete(concepts).where(inArray(concepts.id, ids));
	}

	// Editable schema overlay (per-org) + metadata row.
	await db
		.delete(ontologySchemas)
		.where(and(eq(ontologySchemas.orgId, orgId), eq(ontologySchemas.ontology, ontology)))
		.catch(() => {});
	await db.delete(ontologies).where(eq(ontologies.id, `ont_${ontology}`)).catch(() => {});

	return json({ ok: true, ontology, deletedConcepts: before.entities, deletedSynonyms: before.relations });
};
