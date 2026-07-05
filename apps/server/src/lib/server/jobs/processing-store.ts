/**
 * Cross-process ingestion progress via the processing_jobs table. Fixes the two
 * bugs the audit found: (1) processing_jobs was never written; (2) the worker's
 * in-process progress events were invisible to the API's SSE. Now every stage
 * upserts a row, and the SSE route polls this table so worker progress shows up.
 * Worker-safe (process.env via getDb()).
 */
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
	await db
		.insert(processingJobs)
		.values({
			id: `pj_${e.documentId}`,
			documentId: e.documentId,
			documentTitle: e.documentTitle,
			stage: e.stage,
			progress: e.progress,
			message: e.message
		})
		.onConflictDoUpdate({
			target: processingJobs.id,
			set: { stage: e.stage, progress: e.progress, message: e.message, documentTitle: e.documentTitle }
		});
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
