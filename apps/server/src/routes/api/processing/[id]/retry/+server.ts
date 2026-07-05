import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { documents, processingJobs } from '$lib/server/db/schema';
import { enqueueIngestion } from '$lib/server/jobs/ingestion';
import { requireRole } from '$lib/server/auth-guard';

/** POST /api/processing/[id]/retry — re-enqueue ingestion for the job's document. */
export const POST: RequestHandler = async ({ params, locals }) => {
	requireRole(locals.user, 'editor');
	const db = getDb();
	if (!db) throw error(503, 'A database is required');
	const [job] = await db.select().from(processingJobs).where(eq(processingJobs.id, params.id));
	if (!job) throw error(404, 'job not found');
	const [doc] = await db.select().from(documents).where(eq(documents.id, job.documentId));
	await enqueueIngestion({
		documentId: job.documentId,
		documentTitle: job.documentTitle,
		storageKey: doc?.storageKey ?? undefined
	});
	return json({ ok: true });
};
