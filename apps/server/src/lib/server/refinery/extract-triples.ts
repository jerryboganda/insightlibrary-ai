/**
 * LightRAG-style triple extraction: turn a document's claims into
 * (subject, relation, object) triples and upsert them into the semantic
 * knowledge graph (graph_nodes/graph_edges). Nodes are deduped by slug so the
 * graph stays small and incremental.
 *
 * Nodes are grounded in the ontology dictionary via linkMention() — when a
 * subject/object resolves to a concept, canonical_concept_id and the concept
 * description are written onto the graph node. Edges carry claim provenance:
 * the LLM reports which numbered claim each triple came from and the matching
 * claims.id is persisted as graph_edges.source_claim_id.
 */
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { claims, concepts, graphEdges, graphNodes } from '../db/schema';
import { getRouter } from '../ai/providers';
import { linkMention } from '../ontology/link';

const TRIPLE_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		triples: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					subject: { type: 'string' },
					relation: { type: 'string' },
					object: { type: 'string' },
					claim: { type: 'integer', description: '1-based number of the source claim' }
				},
				required: ['subject', 'relation', 'object', 'claim']
			}
		}
	},
	required: ['triples']
};

function slug(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
}
const nodeId = (name: string) => `n_${slug(name)}`;

interface Grounding {
	conceptId: string;
	description: string;
}

/**
 * Resolve a node label to an ontology concept (exact synonym match first, then
 * embedding NN inside linkMention). Cached per extraction run so repeated
 * mentions of the same entity cost one lookup. Returns null when nothing links
 * (empty ontology, no embeddings key, or distance above threshold).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function groundMention(db: any, name: string, cache: Map<string, Grounding | null>): Promise<Grounding | null> {
	const key = name.toLowerCase();
	if (cache.has(key)) return cache.get(key) ?? null;
	let grounding: Grounding | null = null;
	const link = await linkMention(name).catch(() => null);
	if (link) {
		const rows = await db
			.select({ description: concepts.description })
			.from(concepts)
			.where(eq(concepts.id, link.conceptId))
			.limit(1)
			.catch(() => []);
		grounding = { conceptId: link.conceptId, description: rows[0]?.description ?? '' };
	}
	cache.set(key, grounding);
	return grounding;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function upsertNode(db: any, orgId: string, name: string, cache: Map<string, Grounding | null>): Promise<string> {
	const id = nodeId(name);
	const grounding = await groundMention(db, name, cache);
	await db
		.insert(graphNodes)
		.values({
			id,
			orgId,
			group: 'concept',
			size: 12,
			kind: 'concept',
			label: name,
			canonicalConceptId: grounding?.conceptId ?? null,
			description: grounding?.description ?? ''
		})
		.onConflictDoUpdate({
			target: [graphNodes.orgId, graphNodes.id],
			set: {
				// Backfill grounding onto pre-existing nodes without clobbering
				// anything already grounded.
				canonicalConceptId: sql`COALESCE(${graphNodes.canonicalConceptId}, excluded.canonical_concept_id)`,
				description: sql`CASE WHEN ${graphNodes.description} = '' THEN excluded.description ELSE ${graphNodes.description} END`
			}
		});
	return id;
}

export async function extractTriplesForDocument(documentId: string, orgId: string): Promise<{ triples: number }> {
	const db = getDb();
	if (!db) return { triples: 0 };
	const router = getRouter();
	if (!router.available('extraction')) return { triples: 0 };

	const rows = await db
		.select()
		.from(claims)
		.where(and(eq(claims.documentId, documentId), eq(claims.orgId, orgId)));
	if (!rows.length) return { triples: 0 };

	const batch = rows.slice(0, 80);
	const text = batch.map((c, i) => `${i + 1}. ${c.claimText}`).join('\n');
	const res = await router
		.json<{ triples: { subject: string; relation: string; object: string; claim?: number }[] }>(
			[
				{
					role: 'user',
					content:
						'From these numbered medical claims, extract (subject, relation, object) triples for a knowledge graph. ' +
						'Use concise canonical entity names. For each triple set "claim" to the 1-based number of the claim it was extracted from. ' +
						'Return JSON {"triples":[{"subject":...,"relation":...,"object":...,"claim":1}]}.\n\n' +
						text
				}
			],
			{ task: 'extraction', schema: TRIPLE_SCHEMA, temperature: 0 }
		)
		.catch(() => null);
	if (!res?.triples?.length) return { triples: 0 };

	const groundingCache = new Map<string, Grounding | null>();
	let n = 0;
	for (const tr of res.triples) {
		if (!tr.subject?.trim() || !tr.object?.trim() || !tr.relation?.trim()) continue;
		const sId = await upsertNode(db, orgId, tr.subject.trim(), groundingCache);
		const oId = await upsertNode(db, orgId, tr.object.trim(), groundingCache);
		// Map the LLM-reported claim number back to the real claims.id.
		const idx = typeof tr.claim === 'number' ? Math.floor(tr.claim) : NaN;
		const sourceClaimId = Number.isInteger(idx) && idx >= 1 && idx <= batch.length ? batch[idx - 1].id : null;
		await db
			.insert(graphEdges)
			.values({
				id: `ge_${sId}__${slug(tr.relation)}__${oId}`,
				orgId,
				source: sId,
				target: oId,
				label: tr.relation.trim(),
				rel: tr.relation.trim(),
				weight: 1,
				sourceClaimId
			})
			.onConflictDoUpdate({
				target: graphEdges.id,
				set: {
					// Backfill provenance onto pre-existing edges; keep the first claim.
					sourceClaimId: sql`COALESCE(${graphEdges.sourceClaimId}, excluded.source_claim_id)`
				}
			});
		n++;
	}
	return { triples: n };
}
