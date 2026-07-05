// process.env (not $env/dynamic/private) so this module loads both inside the
// SvelteKit server AND in the standalone pg-boss worker (jobs/worker.ts).
import { sql } from 'drizzle-orm';
import { chunkText, embedText } from '../ai/embeddings';
import { extractText } from '../ingestion/extract';
import { parseDocument, type ParsedDoc } from '../ingestion/parse';
import { contextualizeChunks } from '../ingestion/contextualize';
import { downloadObject } from '../storage/s3';
import { getDb } from '../db/client';
import * as schema from '../db/schema';
import { persistProgress } from './processing-store';
import { extractClaimsForDocument } from '../refinery/extract-claims';
import { correlateDocument } from '../refinery/correlate';

/**
 * Document ingestion pipeline:
 *   extract → parse (pages/blocks) → chunk → contextualize → embed → index.
 *
 * All heavy work runs server-side. Progress is persisted to processing_jobs so
 * it is visible cross-process (worker → API SSE). Runs with real DB writes when
 * DATABASE_URL is set; degrades to a staged simulation otherwise.
 */

export interface IngestionJob {
	documentId: string;
	documentTitle: string;
	text?: string;
	storageKey?: string;
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

interface MetaChunk {
	content: string;
	page: number | null;
	blockId: string | null;
	context: string | null;
	embedding: number[] | null;
}

/** Persist parsed pages + blocks (coverage accounting). No-op without a DB. */
async function persistParsed(documentId: string, parsed: ParsedDoc): Promise<void> {
	const db = getDb();
	if (!db) return;
	if (parsed.pages.length) {
		await db
			.insert(schema.docPages)
			.values(
				parsed.pages.map((p) => ({
					id: `${documentId}_pg${p.pageNo}`,
					documentId,
					pageNo: p.pageNo,
					width: p.width ?? null,
					height: p.height ?? null,
					status: 'parsed'
				}))
			)
			.onConflictDoNothing();
	}
	if (parsed.blocks.length) {
		await db
			.insert(schema.docBlocks)
			.values(
				parsed.blocks.map((b) => ({
					id: `${documentId}_p${b.page}_b${b.readingOrder}`,
					documentId,
					pageNo: b.page,
					kind: b.kind,
					bbox: b.bbox ?? null,
					readingOrder: b.readingOrder,
					content: b.content,
					coverageStatus: 'unaccounted',
					confidence: b.confidence
				}))
			)
			.onConflictDoNothing();
	}
}

/** Coverage accounting: transition blocks unaccounted → chunked → claimed. */
async function markChunkedCoverage(documentId: string): Promise<void> {
	const db = getDb();
	if (!db) return;
	// A block is 'chunked' once its page has produced chunks; back-link a chunk id.
	await db.execute(sql`
		UPDATE doc_blocks b
		SET coverage_status = 'chunked',
		    chunk_id = (SELECT c.id FROM chunks c WHERE c.document_id = b.document_id AND c.page = b.page_no ORDER BY c.id LIMIT 1)
		WHERE b.document_id = ${documentId} AND b.coverage_status = 'unaccounted'
		  AND EXISTS (SELECT 1 FROM chunks c2 WHERE c2.document_id = b.document_id AND c2.page = b.page_no)
	`);
}

async function markClaimedCoverage(documentId: string): Promise<void> {
	const db = getDb();
	if (!db) return;
	// A block is 'claimed' once a claim was extracted from a chunk on its page.
	await db.execute(sql`
		UPDATE doc_blocks b
		SET coverage_status = 'claimed'
		WHERE b.document_id = ${documentId} AND b.coverage_status <> 'claimed'
		  AND EXISTS (
		    SELECT 1 FROM claim_sources cs
		    JOIN chunks c ON c.id = cs.chunk_id
		    JOIN claims cl ON cl.id = cs.claim_id
		    WHERE cl.document_id = b.document_id AND c.page = b.page_no
		  )
	`);
}

/** Write chunks (+ embeddings, context, page, block link) to Postgres. */
async function indexChunks(documentId: string, chunks: MetaChunk[]): Promise<void> {
	const db = getDb();
	if (!db || chunks.length === 0) return;
	await db.insert(schema.chunks).values(
		chunks.map((c, i) => ({
			id: `${documentId}_chunk_${i}`,
			documentId,
			page: c.page,
			content: c.content,
			context: c.context,
			blockId: c.blockId,
			embedding: c.embedding
		}))
	);
}

/** Build page-attributed chunks from parsed blocks (fixes chunks.page = null). */
function buildMetaChunks(documentId: string, parsed: ParsedDoc): MetaChunk[] {
	const out: MetaChunk[] = [];
	for (const p of parsed.pages) {
		const bs = parsed.blocks.filter((b) => b.page === p.pageNo);
		if (!bs.length) continue;
		const pageText = bs.map((b) => b.content).join('\n\n');
		const firstBlockId = `${documentId}_p${p.pageNo}_b${bs[0].readingOrder}`;
		for (const piece of chunkText(pageText)) {
			out.push({ content: piece, page: p.pageNo, blockId: firstBlockId, context: null, embedding: null });
		}
	}
	if (!out.length && parsed.text) {
		for (const piece of chunkText(parsed.text)) {
			out.push({ content: piece, page: null, blockId: null, context: null, embedding: null });
		}
	}
	return out;
}

/** The stage machine — shared by the inline runner and the pg-boss worker. */
export async function runIngestion(job: IngestionJob): Promise<void> {
	const report = async (stage: string, progress: number, message: string) => {
		const e = { documentId: job.documentId, documentTitle: job.documentTitle, stage, progress, message };
		emit(e);
		await persistProgress(e).catch(() => {});
	};

	// 1. Extract
	await report('extract', 10, 'Downloading and extracting text');
	let bytes: Uint8Array | null = null;
	let text = job.text?.trim();
	if (!text && job.storageKey) {
		bytes = await downloadObject(job.storageKey);
		if (bytes) text = (await extractText(bytes, job.storageKey)).trim();
	}
	if (!text) {
		await report('done', 100, 'Indexed (metadata only — no extractable text)');
		return;
	}

	// 2. Parse — structure-aware pages + blocks with coverage accounting.
	await report('parse', 28, 'Parsing structure (pages, blocks)');
	let parsed: ParsedDoc;
	if (bytes && job.storageKey) {
		parsed = await parseDocument(bytes, job.storageKey).catch(() => ({
			pages: [{ pageNo: 1 }],
			blocks: [],
			text: text as string
		}));
	} else {
		parsed = { pages: [{ pageNo: 1 }], blocks: [], text };
	}
	await persistParsed(job.documentId, parsed).catch(() => {});

	// 3. Chunk (page-attributed)
	await report('chunk', 45, 'Splitting into semantic chunks');
	const metaChunks = buildMetaChunks(job.documentId, parsed);

	// 4. Contextualize (Anthropic contextual retrieval — skipped without a provider)
	await report('contextualize', 58, 'Adding contextual prefixes');
	const prefixes = await contextualizeChunks(job.documentTitle, metaChunks.map((c) => c.content));
	metaChunks.forEach((c, i) => (c.context = prefixes[i]));

	// 5. Embed (context + content)
	await report('embed', 74, `Computing embeddings for ${metaChunks.length} chunks`);
	for (const c of metaChunks) {
		const toEmbed = c.context ? `${c.context}\n${c.content}` : c.content;
		c.embedding = await embedText(toEmbed);
	}

	// 6. Index (FTS + pgvector)
	await report('index', 88, 'Writing FTS + pgvector index');
	await indexChunks(job.documentId, metaChunks);
	await markChunkedCoverage(job.documentId).catch(() => {});

	// 7. Extract claims (refinery) — ontology-linked, topic-routed. Skipped
	//    silently when no provider is configured.
	await report('claims', 92, 'Extracting atomic claims');
	const claimRes = await extractClaimsForDocument(job.documentId).catch((e) => {
		console.error('[ingest] claim extraction failed:', e instanceof Error ? e.message : e);
		return { extracted: 0, topics: 0 };
	});
	await markClaimedCoverage(job.documentId).catch(() => {});

	// 8. Correlate — dedup, conflict detection, graph triples, topic versions.
	await report('correlate', 97, 'Deduplicating, detecting conflicts, building graph');
	const corr = await correlateDocument(job.documentId).catch((e) => {
		console.error('[ingest] correlation failed:', e instanceof Error ? e.message : e);
		return { merged: 0, conflicts: 0, triples: 0, versioned: 0 };
	});

	await report(
		'done',
		100,
		`Indexed ${metaChunks.length} chunks / ${parsed.pages.length} pages · ${claimRes.extracted} claims · ` +
			`${corr.merged} merged · ${corr.conflicts} conflicts · ${corr.triples} graph edges`
	);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let boss: any = null;

async function getBoss() {
	if (!process.env.DATABASE_URL) return null;
	if (boss) return boss;
	const { PgBoss } = await import('pg-boss');
	boss = new PgBoss(process.env.DATABASE_URL);
	await boss.start();
	await boss.createQueue(INGESTION_QUEUE);
	return boss;
}

/** Enqueue a document for ingestion (pg-boss when available, inline otherwise). */
export async function enqueueIngestion(job: IngestionJob): Promise<void> {
	await persistProgress({
		documentId: job.documentId,
		documentTitle: job.documentTitle,
		stage: 'queued',
		progress: 0,
		message: 'Queued'
	}).catch(() => {});
	const b = await getBoss();
	if (b) {
		await b.send(INGESTION_QUEUE, job);
	} else {
		void runIngestion(job); // fire-and-forget inline in dev
	}
}
