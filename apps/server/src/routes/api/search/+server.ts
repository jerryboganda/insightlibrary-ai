import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { searchResponseSchema } from '@insightlibrary/schemas';
import { getRepository } from '$lib/server/data';

/**
 * Hybrid search. Postgres path fuses FTS + pgvector via RRF; the in-memory path
 * does substring matching across topics/claims/documents/folders. Either way the
 * client gets a ranked, typed SearchResult[].
 */
export const GET: RequestHandler = async ({ url }) => {
	const q = url.searchParams.get('q') ?? '';
	const { results, mode } = await getRepository().search(q);
	return json(
		searchResponseSchema.parse({ query: q, results, total: results.length, mode })
	);
};
