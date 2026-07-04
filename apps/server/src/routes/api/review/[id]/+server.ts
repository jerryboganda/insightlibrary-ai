import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { getRepository } from '$lib/server/data';

const resolveSchema = z.object({ decision: z.enum(['accepted', 'rejected']) });

export const POST: RequestHandler = async ({ params, request }) => {
	const parsed = resolveSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) throw error(400, 'Invalid decision');
	const item = await getRepository().resolveReview(params.id, parsed.data.decision);
	if (!item) throw error(404, 'Review item not found');
	return json(item);
};
