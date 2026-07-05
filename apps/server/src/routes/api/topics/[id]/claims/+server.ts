import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { desc, eq, inArray } from 'drizzle-orm';
import {
	newClaimSchema,
	normalizedClaimSchema,
	claimStatusSchema,
	claimTypeSchema
} from '@insightlibrary/schemas';
import { getRepository } from '$lib/server/data';
import { getDb } from '$lib/server/db/client';
import { claims, claimSources } from '$lib/server/db/schema';

/**
 * GET /api/topics/[id]/claims?status= — the normalized claims layer (A6):
 * first-class claims with type/confidence/ontology/exam tags, full
 * claim_sources provenance, and the supersede chain (both directions). Each
 * item's core shape is validated against normalizedClaimSchema from
 * @insightlibrary/schemas; rows with out-of-enum values are coerced to the
 * schema defaults rather than dropped so provenance is never hidden.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const db = getDb();
	if (!db) return json({ items: [], total: 0 });

	const statusFilter = claimStatusSchema.safeParse(url.searchParams.get('status'));
	const rows = await db
		.select()
		.from(claims)
		.where(eq(claims.topicId, params.id))
		.orderBy(desc(claims.createdAt));

	const ids = rows.map((r) => r.id);
	const srcRows = ids.length
		? await db.select().from(claimSources).where(inArray(claimSources.claimId, ids))
		: [];
	const sourcesByClaim = new Map<string, typeof srcRows>();
	for (const s of srcRows) {
		const list = sourcesByClaim.get(s.claimId) ?? [];
		list.push(s);
		sourcesByClaim.set(s.claimId, list);
	}

	// Reverse edge of the supersede chain: which claim replaced this one?
	const supersededBy = new Map<string, string>();
	for (const r of rows) {
		if (r.supersedesClaimId) supersededBy.set(r.supersedesClaimId, r.id);
	}

	const items = [];
	for (const r of rows) {
		if (statusFilter.success && r.status !== statusFilter.data) continue;
		// Per-field enum sanitizing keeps legacy/out-of-enum rows visible without
		// misrepresenting their other (valid) fields.
		const candidate = {
			id: r.id,
			topicId: r.topicId,
			sectionId: r.sectionId,
			claimType: claimTypeSchema.safeParse(r.claimType).success ? r.claimType : 'fact',
			claimText: r.claimText,
			ontologyIds: r.ontologyIds ?? [],
			systemTags: r.systemTags ?? [],
			examTags: r.examTags ?? [],
			confidence: typeof r.confidence === 'number' && Number.isFinite(r.confidence) ? r.confidence : 0.5,
			status: claimStatusSchema.safeParse(r.status).success ? r.status : 'active',
			sources: (sourcesByClaim.get(r.id) ?? []).map((s) => ({
				id: s.id,
				claimId: s.claimId,
				sourceId: s.sourceId,
				sourceRef: s.sourceRef,
				locator: s.locator,
				documentId: s.documentId,
				chunkId: s.chunkId,
				blockId: s.blockId,
				stance: s.stance === 'refutes' || s.stance === 'context' ? s.stance : 'supports'
			}))
		};
		const parsed = normalizedClaimSchema.safeParse(candidate);
		if (!parsed.success) continue;
		items.push({
			...parsed.data,
			supersedesClaimId: r.supersedesClaimId ?? null,
			supersededByClaimId: supersededBy.get(r.id) ?? null,
			documentId: r.documentId ?? null,
			createdAt: r.createdAt.toISOString(),
			updatedAt: r.updatedAt.toISOString()
		});
	}

	return json({ items, total: items.length });
};

/** Persist a new claim into a topic's SSOT section. */
export const POST: RequestHandler = async ({ params, request }) => {
	const parsed = newClaimSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) throw error(400, 'Invalid claim payload');
	const claim = await getRepository().addClaim(params.id, parsed.data);
	if (!claim) throw error(404, 'Topic or section not found');
	return json(claim, { status: 201 });
};
