import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { processingJobs } from '$lib/server/db/schema';
import { requireRole } from '$lib/server/auth-guard';

/** POST /api/processing/[id]/cancel — mark a processing job cancelled/failed. */
export const POST: RequestHandler = async ({ params, locals }) => {
	requireRole(locals.user, 'editor');
	const db = getDb();
	if (!db) throw error(503, 'A database is required');
	await db
		.update(processingJobs)
		.set({ stage: 'failed', message: 'Cancelled by user' })
		.where(eq(processingJobs.id, params.id));
	return json({ ok: true });
};
