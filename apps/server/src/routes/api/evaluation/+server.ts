import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRepository } from '$lib/server/data';
import { recentEvalRuns } from '$lib/server/eval/runner';

/**
 * GET /api/evaluation — latest computed metrics plus recent-run history so the
 * dashboard can render REAL trend deltas (gap B34) instead of hardcoded chips.
 * `history` is newest-first from eval_runs (empty when no DB / no prior runs, in
 * which case the UI shows no trend chip). The top-level metrics fields remain
 * exactly the EvaluationMetrics shape existing clients expect.
 *
 * `?history=n` caps the returned run count (default 10, max 50).
 */
export const GET: RequestHandler = async ({ locals, url }) => {
	const orgId = locals.user?.orgId || 'org_1';
	const limitRaw = Number(url.searchParams.get('history') ?? '10');
	const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 50) : 10;

	const [metrics, history] = await Promise.all([
		getRepository().getEvaluation(),
		recentEvalRuns(orgId, limit)
	]);

	return json({ ...metrics, history });
};
