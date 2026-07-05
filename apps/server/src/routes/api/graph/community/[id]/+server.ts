import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getCommunityForNode } from '$lib/server/graph/community';

/** GET /api/graph/community/[id] — the community (+ summary) containing node [id]. */
export const GET: RequestHandler = async ({ params, locals }) => {
	const detail = await getCommunityForNode(locals.user?.orgId || 'org_1', params.id);
	if (!detail) throw error(404, 'node not found in the knowledge graph');
	return json(detail);
};
