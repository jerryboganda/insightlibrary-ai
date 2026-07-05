import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifyTopicPage } from '$lib/server/refinery/verify';

/**
 * POST /api/topics/[id]/verify (B11) — strict verification of the CURRENT
 * SSOT page against its first-class evidence claims WITHOUT recomposing:
 * citation re-anchoring plus NLI entailment when a provider is configured
 * (nliUsed=false in the response means citation-check only). Read-only —
 * returns faithfulness + per-section unsupported sentences, mutates nothing.
 */
export const POST: RequestHandler = async ({ params }) => {
	const res = await verifyTopicPage(params.id, { strict: true });
	if (!res.ok) {
		if (res.reason === 'topic not found') throw error(404, res.reason);
		if (res.reason === 'no database') throw error(503, 'Verification requires the database');
		throw error(422, res.reason ?? 'Verification unavailable for this topic');
	}
	return json(res);
};
