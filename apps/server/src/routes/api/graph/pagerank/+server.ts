import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPageRank } from '$lib/server/graph/community';

/** GET /api/graph/pagerank — most central concepts by PageRank. */
export const GET: RequestHandler = async ({ locals }) => {
	const ranked = await getPageRank(locals.user?.orgId || 'org_1');
	const items = ranked.slice(0, 30);
	return json({ items, total: items.length });
};
