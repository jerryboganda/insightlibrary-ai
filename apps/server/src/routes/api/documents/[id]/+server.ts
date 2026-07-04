import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRepository } from '$lib/server/data';

export const GET: RequestHandler = async ({ params }) => {
	const doc = await getRepository().getDocument(params.id);
	if (!doc) throw error(404, 'Document not found');
	return json(doc);
};
