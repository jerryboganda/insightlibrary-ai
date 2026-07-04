import { PgBoss } from 'pg-boss';
import { INGESTION_QUEUE, runIngestion, type IngestionJob } from './ingestion.ts';

/**
 * Standalone ingestion worker. Run alongside the API server in production:
 *   DATABASE_URL=... pnpm --filter @insightlibrary/server worker
 * Keeps CPU-heavy extraction/embedding off the request path.
 */
async function main() {
	const url = process.env.DATABASE_URL;
	if (!url) {
		console.error('DATABASE_URL is required to run the pg-boss worker.');
		process.exit(1);
	}
	const boss = new PgBoss(url);
	await boss.start();
	// pg-boss v12 requires the queue to exist before work() (idempotent).
	await boss.createQueue(INGESTION_QUEUE);
	await boss.work<IngestionJob>(INGESTION_QUEUE, async (jobs: Array<{ data: IngestionJob }>) => {
		for (const job of jobs) {
			console.info(`[worker] ingesting ${job.data.documentTitle}`);
			await runIngestion(job.data);
		}
	});
	console.info('[worker] listening on', INGESTION_QUEUE);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
