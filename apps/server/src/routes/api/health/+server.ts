import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { healthResponseSchema } from '@insightlibrary/schemas';
import { getRepository } from '$lib/server/data';

export const GET: RequestHandler = () => {
	const repo = getRepository();
	return json(
		healthResponseSchema.parse({
			status: 'ok',
			service: 'insightlibrary-server',
			version: '0.1.0',
			dataSource: repo.kind,
			time: new Date().toISOString()
		})
	);
};
