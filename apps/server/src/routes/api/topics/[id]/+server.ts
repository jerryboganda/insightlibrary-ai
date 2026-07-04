import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRepository } from '$lib/server/data';

/** Full SSOT view for a topic: sections/claims + coverage matrix + delta feed. */
export const GET: RequestHandler = async ({ params }) => {
	const repo = getRepository();
	const topic = await repo.getTopic(params.id);
	if (!topic) throw error(404, 'Topic not found');
	const [coverage, delta] = await Promise.all([
		repo.getCoverage(params.id),
		repo.getDelta(params.id)
	]);
	return json({ topic, coverage, delta });
};
