import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRepository } from '$lib/server/data';

export const GET: RequestHandler = async () => {
	const items = await getRepository().listUsers();
	return json({ items, total: items.length });
};
