import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRepository } from '$lib/server/data';
import { getUsageSummary } from '$lib/server/usage/metering';

/**
 * GET /api/usage[?period=month|all] — real AI usage aggregated live from the
 * usage_events metering ledger (spend, calls by task, provider/model rollup,
 * active users, live storage size) plus the org's budget configuration.
 * Defaults to the current calendar month; ?period=all covers all time.
 * Falls back to the in-memory seed repository only when no database is
 * configured (dev zero-services mode).
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	const orgId = locals.user?.orgId || 'org_1';
	const period = url.searchParams.get('period') === 'all' ? 'all' : 'month';
	const summary = await getUsageSummary(orgId, period);
	if (summary) return json(summary);
	return json(await getRepository().getUsage());
};
