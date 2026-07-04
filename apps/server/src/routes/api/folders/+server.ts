import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { getRepository } from '$lib/server/data';

export const GET: RequestHandler = async () => {
	const items = await getRepository().listFolders();
	return json({ items, total: items.length });
};

const createSchema = z.object({ name: z.string().min(1).max(120) });

export const POST: RequestHandler = async ({ request }) => {
	const parsed = createSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) throw error(400, 'Invalid folder payload');
	const folder = await getRepository().createFolder(parsed.data);
	return json(folder, { status: 201 });
};
