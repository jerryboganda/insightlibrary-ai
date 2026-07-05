import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { getRepository } from '$lib/server/data';
import { resolveClaimConflict } from '$lib/server/refinery/conflict';
import { dispatchWebhooks } from '$lib/server/webhooks/dispatch';
import { notify } from '$lib/server/webhooks/notify';

const resolveSchema = z.object({ decision: z.enum(['accepted', 'rejected']) });

/**
 * POST /api/review/[id] { decision } — decide a review-queue item.
 *
 * Beyond flipping review_items.status, a conflict decision now settles the
 * underlying claims (gap B21): accepted → the incoming claim goes active and
 * the original is superseded; rejected → the original is restored and the
 * incoming claim retired. Both directions unfreeze the 'conflicted' state.
 * Resolution also notifies the org (B20) and fires the 'review.resolved'
 * webhook (B3) — both fire-and-forget.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const parsed = resolveSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) throw error(400, 'Invalid decision');
	const decision = parsed.data.decision;
	const orgId = locals.user?.orgId || 'org_1';

	const item = await getRepository().resolveReview(params.id, decision);
	if (!item) throw error(404, 'Review item not found');

	// Settle the conflicted claims behind the item (no-op without a DB or for
	// non-conflict items; never blocks the decision itself).
	const resolution = await resolveClaimConflict(params.id, decision, orgId).catch((e) => {
		console.error('[review] claim-conflict resolution failed:', e instanceof Error ? e.message : e);
		return {
			resolved: false,
			winnerClaimId: null,
			loserClaimId: null,
			detail: 'Claim resolution failed — see server logs'
		};
	});

	notify(orgId, {
		type: 'ssot_merge',
		title: decision === 'accepted' ? 'Conflict resolved — new claim accepted' : 'Conflict resolved — original claim kept',
		description:
			(item.topic ? `${item.topic}: ` : '') +
			`"${item.newClaim.slice(0, 110)}" was ${decision} by ${locals.user?.email ?? 'a reviewer'}.` +
			(resolution.resolved ? ` ${resolution.detail}.` : ''),
		action: '/review',
		dedupeKey: `resolved_${params.id}`
	});
	void dispatchWebhooks(orgId, 'review.resolved', {
		reviewItemId: item.id,
		decision,
		topic: item.topic,
		newClaim: item.newClaim,
		originalClaim: item.originalClaim,
		claimsSettled: resolution.resolved,
		winnerClaimId: resolution.winnerClaimId,
		loserClaimId: resolution.loserClaimId,
		resolvedBy: locals.user?.email ?? null
	}).catch(() => {});

	// Additive: the item plus what happened to the underlying claims.
	return json({ ...item, resolution });
};
