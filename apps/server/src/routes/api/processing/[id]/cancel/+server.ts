import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { documents, processingJobs } from '$lib/server/db/schema';
import { requireRole } from '$lib/server/auth-guard';
import { getJobCancelInfo } from '$lib/server/jobs/processing-store';
import { cancelBossJob } from '$lib/server/jobs/ingestion';

/**
 * POST /api/processing/[id]/cancel — really cancel a processing job (gap B22):
 * mark the row failed, flip the document out of 'processing', and stop the
 * pg-boss job — queued jobs via boss.cancel(); an already-running pipeline
 * aborts at its next cooperative checkpoint (see jobs/ingestion.ts).
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	requireRole(locals.user, 'editor');
	const db = getDb();
	if (!db) throw error(503, 'A database is required');

	const info = await getJobCancelInfo(params.id);
	if (!info) throw error(404, 'Processing job not found');
	// Nothing left to cancel — do not clobber a completed job/document.
	if (info.stage === 'done') return json({ ok: true, alreadyCompleted: true });

	await db
		.update(processingJobs)
		.set({ stage: 'failed', message: 'Cancelled by user' })
		.where(eq(processingJobs.id, params.id));

	// Honest document status: a cancelled ingestion is no longer 'processing'.
	await db
		.update(documents)
		.set({ status: 'failed', statusLabel: 'Cancelled' })
		.where(and(eq(documents.id, info.documentId), eq(documents.status, 'processing')));

	// Best effort: stop the pg-boss job before a worker picks it up. Running
	// jobs are covered by the cooperative checkpoints instead.
	if (info.bossJobId) {
		await cancelBossJob(info.bossJobId).catch((e) => {
			console.warn('[cancel] pg-boss cancel failed (job may already be running):', e);
		});
	}

	return json({ ok: true });
};
