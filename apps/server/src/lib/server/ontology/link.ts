/**
 * Entity linking + alias expansion.
 *  - linkMention(): exact synonym/prefLabel match first (high precision), then
 *    embedding nearest-neighbor over concept_embeddings (recall).
 *  - expandAliases(): concept prefLabel + synonyms + 1-hop neighbor labels, used
 *    by the topic-recall audit and topic composition.
 * Worker-safe (process.env via getDb()).
 */
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { embedText } from '../ai/embeddings';

export interface LinkResult {
	conceptId: string;
	prefLabel: string;
	ontology: string;
	score: number;
}

const DISTANCE_THRESHOLD = Number(process.env.ONTOLOGY_LINK_MAX_DISTANCE ?? '0.4');

export async function linkMention(mention: string): Promise<LinkResult | null> {
	const db = getDb();
	if (!db) return null;
	const clean = mention.trim();
	if (!clean) return null;

	// 1. Exact match on preferred label or synonym.
	const exact = await db.execute<{ id: string; pref_label: string; ontology: string }>(sql`
		SELECT c.id, c.pref_label, c.ontology
		FROM concepts c
		WHERE lower(c.pref_label) = lower(${clean})
		UNION
		SELECT c.id, c.pref_label, c.ontology
		FROM concept_synonyms s JOIN concepts c ON c.id = s.concept_id
		WHERE lower(s.synonym) = lower(${clean})
		LIMIT 1
	`);
	if (exact.rows.length) {
		const r = exact.rows[0];
		return { conceptId: r.id, prefLabel: r.pref_label, ontology: r.ontology, score: 1 };
	}

	// 2. Embedding nearest-neighbor over concept label embeddings.
	const qvec = await embedText(clean).catch(() => null);
	if (!qvec) return null;
	const literal = `[${qvec.join(',')}]`;
	const nn = await db.execute<{ id: string; pref_label: string; ontology: string; dist: number }>(sql`
		SELECT c.id, c.pref_label, c.ontology, ce.embedding <=> ${literal}::vector AS dist
		FROM concept_embeddings ce JOIN concepts c ON c.id = ce.concept_id
		WHERE ce.embedding IS NOT NULL
		ORDER BY ce.embedding <=> ${literal}::vector
		LIMIT 1
	`);
	if (!nn.rows.length) return null;
	const r = nn.rows[0];
	if (Number(r.dist) > DISTANCE_THRESHOLD) return null;
	return { conceptId: r.id, prefLabel: r.pref_label, ontology: r.ontology, score: 1 - Number(r.dist) };
}

/**
 * All search aliases for a mention: the linked concept's preferred label +
 * synonyms + labels of its 1-hop neighbors. Returns the mention itself if
 * nothing links, so callers can always query with at least the surface form.
 */
export async function expandAliases(mention: string): Promise<string[]> {
	const db = getDb();
	const base = new Set<string>([mention.trim()].filter(Boolean));
	if (!db) return [...base];
	const link = await linkMention(mention).catch(() => null);
	if (!link) return [...base];

	const rows = await db.execute<{ label: string }>(sql`
		SELECT c.pref_label AS label FROM concepts c WHERE c.id = ${link.conceptId}
		UNION
		SELECT s.synonym AS label FROM concept_synonyms s WHERE s.concept_id = ${link.conceptId}
		UNION
		SELECT c2.pref_label AS label
		FROM concept_edges e JOIN concepts c2 ON c2.id = e.target_concept_id
		WHERE e.source_concept_id = ${link.conceptId}
		UNION
		SELECT c3.pref_label AS label
		FROM concept_edges e2 JOIN concepts c3 ON c3.id = e2.source_concept_id
		WHERE e2.target_concept_id = ${link.conceptId}
	`);
	for (const r of rows.rows) if (r.label) base.add(r.label);
	return [...base];
}
