/**
 * Claim extraction — turns a document's indexed chunks into atomic, first-class
 * claims via the provider layer's structured output, links each to an ontology
 * concept, routes it to an existing/new topic, and records provenance to the
 * source chunk/block. Runs as the 'claims' ingestion stage after indexing.
 * Idempotent (deterministic ids + onConflictDoNothing). Worker-safe.
 */
import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { chunks as chunksTable, claims, claimSources, documents, sources as sourcesTable, topics } from '../db/schema';
import { getRouter } from '../ai/providers';
import { embedText } from '../ai/embeddings';
import { getOrgSettings } from '../org-settings';
import { linkMention, type LinkResult } from '../ontology/link';

interface ExtractedClaim {
	text: string;
	claimType?: string;
	topic?: string;
	systemTags?: string[];
	examTags?: string[];
}

const CLAIM_JSON_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		claims: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					text: { type: 'string' },
					claimType: { type: 'string' },
					topic: { type: 'string' },
					systemTags: { type: 'array', items: { type: 'string' } },
					examTags: { type: 'array', items: { type: 'string' } }
				},
				required: ['text']
			}
		}
	},
	required: ['claims']
};

const ALLOWED_TYPES = new Set([
	'fact', 'definition', 'mechanism', 'classification', 'symptom', 'sign', 'lab',
	'diagnosis', 'treatment', 'pharmacology', 'complication', 'differential',
	'exam_pearl', 'contraindication', 'table_fact', 'figure_fact'
]);

function slug(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

/**
 * Map an ingested document to a registered sources-registry row (A5) by name
 * metadata: exact title match first, then containment either way. Longest
 * source name wins on ambiguity. Returns null when nothing plausibly matches —
 * callers keep the raw-token/document-id provenance fallback in that case.
 */
export function matchRegisteredSource<T extends { id: string; name: string }>(
	docTitle: string,
	candidates: T[]
): T | null {
	const title = docTitle.trim().toLowerCase();
	if (title.length < 3) return null;
	let best: T | null = null;
	let bestLen = 0;
	for (const s of candidates) {
		const name = s.name.trim().toLowerCase();
		if (name.length < 3) continue;
		const hit =
			name === title ||
			(name.length >= 4 && title.includes(name)) ||
			(title.length >= 4 && name.includes(title));
		if (hit && name.length > bestLen) {
			best = s;
			bestLen = name.length;
		}
	}
	return best;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function routeTopic(db: any, orgId: string, topicName: string | undefined, link: LinkResult | null): Promise<string | null> {
	const name = (link?.prefLabel ?? topicName ?? '').trim();
	if (name.length < 3) return null;
	const existing = await db.execute(
		sql`SELECT id FROM topics WHERE org_id = ${orgId} AND lower(name) = lower(${name}) LIMIT 1`
	);
	if (existing.rows.length) return existing.rows[0].id as string;
	const id = `t_${slug(name)}_${Date.now()}`;
	await db
		.insert(topics)
		.values({ id, orgId, name, aliases: link ? [link.prefLabel] : [], health: 50, updates: 0, folder: '', sections: [] })
		.onConflictDoNothing();
	return id;
}

export async function extractClaimsForDocument(
	documentId: string,
	orgId = 'org_1'
): Promise<{ extracted: number; topics: number }> {
	const db = getDb();
	if (!db) return { extracted: 0, topics: 0 };
	const router = getRouter(orgId);
	if (!router.available('extraction')) return { extracted: 0, topics: 0 };

	const rows = await db.select().from(chunksTable).where(eq(chunksTable.documentId, documentId));
	// Org-managed cap (admin governance page) with the env default folded in by
	// the settings store — replaces the previous env-only CLAIMS_MAX_CHUNKS read.
	const settings = await getOrgSettings(orgId).catch(() => null);
	const cap = settings?.claimsMaxChunks ?? Number(process.env.CLAIMS_MAX_CHUNKS ?? '60');
	let extracted = 0;
	const touchedTopics = new Set<string>();

	// Provenance (A5): when the document corresponds to a registered source,
	// stamp claim_sources.source_id (+ its id as the sourceRef token) so the
	// coverage matrix and citation chips resolve to the registry. Unmatched
	// documents keep the existing raw-token/document-id fallback.
	let matchedSource: { id: string; name: string } | null = null;
	try {
		const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
		if (doc) {
			const registry = await db.select().from(sourcesTable).where(eq(sourcesTable.orgId, orgId));
			matchedSource = matchRegisteredSource(doc.title, registry);
		}
	} catch (e) {
		console.error('[extract-claims] source registry match failed:', e instanceof Error ? e.message : e);
	}

	for (let i = 0; i < Math.min(rows.length, cap); i++) {
		const chunk = rows[i];
		const res = await router
			.json<{ claims: ExtractedClaim[] }>(
				[
					{
						role: 'user',
						content:
							'Extract atomic, self-contained medical claims from the passage. Each claim is one verifiable fact. ' +
							'For each, give: text; claimType (one of fact, definition, mechanism, symptom, sign, lab, diagnosis, ' +
							'treatment, pharmacology, complication, differential, exam_pearl, contraindication); topic (the canonical ' +
							'disease/concept it is about); systemTags (body systems); examTags (e.g. high_yield). ' +
							`Return JSON {"claims":[...]}. Passage:\n"""${chunk.content.slice(0, 2500)}"""`
					}
				],
				{ task: 'extraction', schema: CLAIM_JSON_SCHEMA, temperature: 0 }
			)
			.catch(() => null);
		if (!res?.claims?.length) continue;

		for (let j = 0; j < res.claims.length; j++) {
			const cl = res.claims[j];
			const text = cl.text?.trim();
			if (!text) continue;
			const link = cl.topic ? await linkMention(cl.topic).catch(() => null) : null;
			const topicId = await routeTopic(db, orgId, cl.topic, link);
			if (topicId) touchedTopics.add(topicId);

			const claimId = `xc_${chunk.id}_${j}`;
			const claimType = cl.claimType && ALLOWED_TYPES.has(cl.claimType) ? cl.claimType : 'fact';
			const emb = await embedText(text, { orgId }).catch(() => null);
			await db
				.insert(claims)
				.values({
					id: claimId,
					orgId,
					topicId,
					documentId,
					claimType,
					claimText: text,
					normalizedMeaning: emb,
					ontologyIds: link ? [link.conceptId] : [],
					systemTags: cl.systemTags ?? [],
					examTags: cl.examTags ?? [],
					confidence: 0.7,
					status: 'active'
				})
				.onConflictDoNothing();
			await db
				.insert(claimSources)
				.values({
					id: `cs_${claimId}`,
					claimId,
					sourceId: matchedSource?.id ?? null,
					sourceRef: matchedSource?.id ?? null,
					locator: chunk.page != null ? `p${chunk.page}` : null,
					documentId,
					chunkId: chunk.id,
					blockId: chunk.blockId ?? null,
					stance: 'supports'
				})
				.onConflictDoNothing();
			extracted++;
		}
	}
	return { extracted, topics: touchedTopics.size };
}
