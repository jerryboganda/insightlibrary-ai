import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { expandAliases } from '$lib/server/ontology/link';

/** GET /api/ontology/expand?q=Addison — aliases + ontology neighbors for recall. */
export const GET: RequestHandler = async ({ url }) => {
	const q = url.searchParams.get('q');
	if (!q) throw error(400, 'q query param required');
	const aliases = await expandAliases(q);
	return json({ query: q, aliases });
};
