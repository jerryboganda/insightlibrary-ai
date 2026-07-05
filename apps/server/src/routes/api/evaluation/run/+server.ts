import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runGoldenEval } from '$lib/server/eval/runner';

/** POST /api/evaluation/run — run the golden set, compute + persist metrics. */
export const POST: RequestHandler = async ({ locals }) => {
	const metrics = await runGoldenEval(locals.user?.orgId || 'org_1');
	return json(metrics);
};
