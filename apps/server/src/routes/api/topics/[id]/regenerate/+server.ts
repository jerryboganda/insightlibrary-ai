import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { composeTopic } from '$lib/server/refinery/compose';

/** POST /api/topics/[id]/regenerate — evidence-only compose + verify, writes a new version. */
export const POST: RequestHandler = async ({ params }) => {
	const res = await composeTopic(params.id);
	if (!res.ok) throw error(422, res.reason ?? 'Could not compose topic');
	return json(res);
};
