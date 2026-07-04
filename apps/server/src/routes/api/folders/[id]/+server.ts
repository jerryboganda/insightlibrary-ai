import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRepository } from '$lib/server/data';

export const GET: RequestHandler = async ({ params }) => {
	const repo = getRepository();
	const folder = await repo.getFolder(params.id);
	if (!folder) throw error(404, 'Folder not found');
	const documents = await repo.listDocuments(params.id);
	return json({ folder, documents });
};
