// process.env (not $env/dynamic/private) so this module loads both inside the
// SvelteKit server AND in the standalone pg-boss worker (jobs/worker.ts).
import { chunkText, embedText } from '../ai/embeddings';

/**
 * Document ingestion pipeline: extract → chunk → embed → index.
 *
 * With DATABASE_URL, jobs are enqueued to pg-boss (transactional, Postgres-only,
 * no Redis) and executed by the worker (jobs/worker.ts); the embed + index stages
 * do real work — chunking, Gemini embeddings, and pgvector/FTS writes. Without a
 * DB, the pipeline runs inline as a staged simulation so uploads still "process"
 * in dev. Extracting text from a binary PDF requires a native lib (pdfium) + the
 * uploaded file; when `text` is supplied (or a doc is text) the real path runs.
 */

export interface IngestionJob {
	documentId: string;
	documentTitle: string;
	/** Extracted document text, when available (real embed/index path). */
	text?: string;
}

export const INGESTION_QUEUE = 'document-ingestion';

type ProgressListener = (e: {
	documentId: string;
	documentTitle: string;
	stage: string;
	progress: number;
	message: string;
}) => void;

const listeners = new Set<ProgressListener>();

export function onIngestionProgress(fn: ProgressListener): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

function emit(e: Parameters<ProgressListener>[0]) {
	for (const fn of listeners) fn(e);
}

/** Write chunks (+ optional embeddings) to Postgres. No-op without DATABASE_URL. */
async function indexChunks(
	documentId: string,
	chunks: Array<{ content: string; embedding: number[] | null }>
): Promise<void> {
	const url = process.env.DATABASE_URL;
	if (!url || chunks.length === 0) return;
	const pg = (await import('pg')).default;
	const { drizzle } = await import('drizzle-orm/node-postgres');
	const schema = await import('../db/schema');
	const pool = new pg.Pool({ connectionString: url });
	try {
		const db = drizzle(pool, { schema });
		await db.insert(schema.chunks).values(
			chunks.map((c, i) => ({
				id: `${documentId}_chunk_${i}`,
				documentId,
				page: null,
				content: c.content,
				embedding: c.embedding
			}))
		);
	} finally {
		await pool.end();
	}
}

/** The stage machine — shared by the inline runner and the pg-boss worker. */
export async function runIngestion(job: IngestionJob): Promise<void> {
	const step = (stage: string, progress: number, message: string) =>
		emit({ documentId: job.documentId, documentTitle: job.documentTitle, stage, progress, message });

	// 1. Extract
	step('extract', 12, 'Extracting text (pdfium / OCR)');
	const text = job.text?.trim();
	if (!text) {
		// No text available (binary PDF needs pdfium + the file). Simulate the
		// remaining stages so the processing UI still advances, then finish.
		for (const [stage, pct, msg] of [
			['chunk', 40, 'Splitting into semantic chunks'],
			['embed', 70, 'Computing embeddings (gemini-embedding-001)'],
			['index', 92, 'Writing FTS + pgvector index']
		] as const) {
			step(stage, pct, msg);
			await new Promise((r) => setTimeout(r, 300));
		}
		step('done', 100, 'Indexed (metadata only — no extractable text)');
		return;
	}

	// 2. Chunk
	step('chunk', 40, 'Splitting into semantic chunks');
	const chunks = chunkText(text);

	// 3. Embed
	step('embed', 60, `Computing embeddings for ${chunks.length} chunks`);
	const embedded = [];
	for (const content of chunks) {
		embedded.push({ content, embedding: await embedText(content) });
	}

	// 4. Index (FTS + pgvector)
	step('index', 88, 'Writing FTS + pgvector index');
	await indexChunks(job.documentId, embedded);

	step('done', 100, `Indexed ${chunks.length} chunks`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let boss: any = null;

async function getBoss() {
	if (!process.env.DATABASE_URL) return null;
	if (boss) return boss;
	const { PgBoss } = await import('pg-boss');
	boss = new PgBoss(process.env.DATABASE_URL);
	await boss.start();
	// pg-boss v12 requires queues to exist before send()/work() (idempotent).
	await boss.createQueue(INGESTION_QUEUE);
	return boss;
}

/** Enqueue a document for ingestion (pg-boss when available, inline otherwise). */
export async function enqueueIngestion(job: IngestionJob): Promise<void> {
	const b = await getBoss();
	if (b) {
		await b.send(INGESTION_QUEUE, job);
	} else {
		void runIngestion(job); // fire-and-forget inline in dev
	}
}
