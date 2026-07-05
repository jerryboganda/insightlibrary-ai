/**
 * Cross-process ingestion progress via the processing_jobs table. Fixes the two
 * bugs the audit found: (1) processing_jobs was never written; (2) the worker's
 * in-process progress events were invisible to the API's SSE. Now every stage
 * upserts a row, and the SSE route polls this table so worker progress shows up.
 * Worker-safe (process.env via getDb()).
 *
 * Also carries the cooperative-cancellation contract (gap B22): the cancel
 * endpoint flips a row to stage='failed', the running pipeline re-reads the row
 * between stages via isJobCancelled() and aborts. The upsert is guarded so a
 * still-running pipeline cannot resurrect a cancelled row — once 'failed', only
 * a fresh 'queued' (retry / re-enqueue) or another 'failed' may overwrite it.
 */
import { eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { processingJobs } from '../db/schema';

export interface ProgressEvent {
	documentId: string;
	documentTitle: string;
	stage: string;
	progress: number;
	message: string;
}

export async function persistProgress(e: ProgressEvent): Promise<void> {
	const db = getDb();
	if (!db) return;
	await db.execute(sql`
		INSERT INTO processing_jobs (id, document_id, document_title, stage, progress, message)
		VALUES (${`pj_${e.documentId}`}, ${e.documentId}, ${e.documentTitle}, ${e.stage}, ${e.progress}, ${e.message})
		ON CONFLICT (id) DO UPDATE
		SET stage = EXCLUDED.stage,
		    progress = EXCLUDED.progress,
		    message = EXCLUDED.message,
		    document_title = EXCLUDED.document_title
		WHERE processing_jobs.stage <> 'failed' OR EXCLUDED.stage IN ('queued', 'failed')
	`);
}

/**
 * Cooperative-cancellation probe: true when the job's row was externally marked
 * 'failed' (Cancel Job) while the pipeline is still running. A retry always
 * resets the row to 'queued' first, so an in-flight retry never sees stale
 * 'failed' state from a previous attempt.
 */
export async function isJobCancelled(documentId: string): Promise<boolean> {
	const db = getDb();
	if (!db) return false;
	const [row] = await db
		.select({ stage: processingJobs.stage })
		.from(processingJobs)
		.where(eq(processingJobs.id, `pj_${documentId}`));
	return row?.stage === 'failed';
}

/**
 * Remember the pg-boss job id so the cancel endpoint can boss.cancel() a job
 * that is still queued. The column is added by migration
 * 0008_document_status_backfill.sql; raw SQL keeps this worker-safe even if
 * drizzle schema metadata lags behind. Best-effort — callers .catch().
 */
export async function setBossJobId(documentId: string, bossJobId: string): Promise<void> {
	const db = getDb();
	if (!db) return;
	await db.execute(
		sql`UPDATE processing_jobs SET boss_job_id = ${bossJobId} WHERE id = ${`pj_${documentId}`}`
	);
}

export interface JobCancelInfo {
	documentId: string;
	stage: string;
	bossJobId: string | null;
}

/** Read the fields the cancel endpoint needs. Null when the row is missing. */
export async function getJobCancelInfo(processingJobId: string): Promise<JobCancelInfo | null> {
	const db = getDb();
	if (!db) return null;
	try {
		const res = await db.execute(
			sql`SELECT document_id, stage, boss_job_id FROM processing_jobs WHERE id = ${processingJobId}`
		);
		const row = res.rows?.[0] as
			| { document_id: string; stage: string; boss_job_id: string | null }
			| undefined;
		if (!row) return null;
		return { documentId: row.document_id, stage: row.stage, bossJobId: row.boss_job_id ?? null };
	} catch {
		// boss_job_id column not migrated yet — fall back to the drizzle columns.
		const [row] = await db
			.select({ documentId: processingJobs.documentId, stage: processingJobs.stage })
			.from(processingJobs)
			.where(eq(processingJobs.id, processingJobId));
		if (!row) return null;
		return { documentId: row.documentId, stage: row.stage, bossJobId: null };
	}
}

export async function listProgressRows(): Promise<ProgressEvent[]> {
	const db = getDb();
	if (!db) return [];
	const rows = await db.select().from(processingJobs);
	return rows.map((r) => ({
		documentId: r.documentId,
		documentTitle: r.documentTitle,
		stage: r.stage,
		progress: r.progress,
		message: r.message
	}));
}
