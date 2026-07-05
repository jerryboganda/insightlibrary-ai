import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getCommunities } from '$lib/server/graph/community';

/** GET /api/graph/communities — GraphRAG communities (connected components). */
export const GET: RequestHandler = async ({ locals }) => {
	const items = await getCommunities(locals.user?.orgId || 'org_1');
	return json({ items, total: items.length });
};
