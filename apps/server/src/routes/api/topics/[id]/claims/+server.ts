import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { newClaimSchema } from '@insightlibrary/schemas';
import { getRepository } from '$lib/server/data';

/** Persist a new claim into a topic's SSOT section. */
export const POST: RequestHandler = async ({ params, request }) => {
	const parsed = newClaimSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) throw error(400, 'Invalid claim payload');
	const claim = await getRepository().addClaim(params.id, parsed.data);
	if (!claim) throw error(404, 'Topic or section not found');
	return json(claim, { status: 201 });
};
