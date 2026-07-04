import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRepository } from '$lib/server/data';

export const GET: RequestHandler = async ({ url }) => {
	const topicId = url.searchParams.get('topicId') ?? undefined;
	const items = await getRepository().listFlashcards(topicId);
	return json({ items, total: items.length });
};
