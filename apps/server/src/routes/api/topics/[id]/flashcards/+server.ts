import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { generateFlashcardsForTopic } from '$lib/server/refinery/flashcards';

/** POST /api/topics/[id]/flashcards { count? } — generate flashcards from claims. */
export const POST: RequestHandler = async ({ params, request }) => {
	const body = (await request.json().catch(() => ({}))) as { count?: number };
	const res = await generateFlashcardsForTopic(params.id, body?.count ?? 8);
	return json(res);
};
