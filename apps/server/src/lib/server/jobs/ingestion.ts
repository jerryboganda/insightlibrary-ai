// process.env (not $env/dynamic/private) so this module loads both inside the
// SvelteKit server AND in the standalone pg-boss worker (jobs/worker.ts).
import { eq, sql } from 'drizzle-orm';
import { chunkText, embedText } from '../ai/embeddings';
import { extractText } from '../ingestion/extract';
import { parseDocument, type ParsedDoc } from '../ingestion/parse';
import { contextualizeChunks } from '../ingestion/contextualize';
import { downloadObject } from '../storage/s3';
import { getDb } from '../db/client';
import * as schema from '../db/schema';
import { getOrgSettings } from '../org-settings';
import { isJobCancelled, persistProgress, setBossJobId } from './processing-store';
import { extractClaimsForDocument } from '../refinery/extract-claims';
import { correlateDocument } from '../refinery/correlate';
import { dispatchWebhooks } from '../webhooks/dispatch';
import { notify } from '../webhooks/notify';

/**
 * Document ingestion pipeline:
 *   extract → parse (pages/blocks) → chunk → contextualize → embed → index.
 *
 * All heavy work runs server-side. Progress is persisted to processing_jobs so
 * it is visible cross-process (worker → API SSE). Runs with real DB writes when
 * DATABASE_URL is set; degrades to a staged simulation otherwise.
 *
 * documents.status lifecycle (gap B9): 'processing' while queued/running,
 * 'indexed' on success (pages refreshed from parse output), 'failed' on error
 * or user cancellation — the UI renders exactly these values.
 *
 * Cancellation (gap B22): POST /api/processing/[id]/cancel flips the
 * processing_jobs row to stage='failed' and (when still queued) boss.cancel()s
 * the pg-boss job. A running pipeline re-reads the row at every stage boundary
 * (and periodically inside the embed loop) and aborts before spending more
 * tokens.
 */

export interface IngestionJob {
	documentId: string;
	documentTitle: string;
	text?: string;
	storageKey?: string;
}

export const INGESTION_QUEUE = 'document-ingestion';

/** Thrown at a cooperative checkpoint when the job was cancelled by the user. */
export class IngestionCancelledError extends Error {
	constructor() {
		super('Ingestion cancelled by user');
		this.name = 'IngestionCancelledError';
	}
}

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

interface OrgContext {
	orgId: string;
	folderId: string | null;
}

/**
 * Resolve the document's org (via its folder) so parse-mode/settings lookups,
 * BYO-key embedding calls, refinery stages, webhooks and notifications are all
 * scoped to the right tenant instead of the hardcoded default.
 */
async function resolveOrgContext(documentId: string): Promise<OrgContext> {
	const db = getDb();
	if (!db) return { orgId: 'org_1', folderId: null };
	try {
		const res = await db.execute<{ org_id: string; folder_id: string }>(sql`
			SELECT f.org_id, d.folder_id
			FROM documents d JOIN folders f ON f.id = d.folder_id
			WHERE d.id = ${documentId}
		`);
		const row = res.rows[0];
		if (row?.org_id) return { orgId: row.org_id, folderId: row.folder_id ?? null };
	} catch {
		/* fall through to default */
	}
	return { orgId: 'org_1', folderId: null };
}

/** Fire the terminal document webhooks + human notification. Never throws. */
function emitDocumentEvent(
	ctx: OrgContext,
	job: IngestionJob,
	outcome: 'indexed' | 'failed',
	detail: Record<string, unknown>,
	description: string
): void {
	const action = ctx.folderId ? `/folders/${ctx.folderId}/${job.documentId}` : null;
	void dispatchWebhooks(ctx.orgId, `document.${outcome}`, {
		documentId: job.documentId,
		title: job.documentTitle,
		...detail
	}).catch(() => {});
	notify(ctx.orgId, {
		type: outcome === 'indexed' ? 'novelty' : 'alert',
		title: outcome === 'indexed' ? 'Document indexed' : 'Ingestion failed',
		description,
		action
	});
}

/** Advance documents.status/status_label (+pages when known). No-op without a DB. */
async function markDocumentStatus(
	documentId: string,
	status: 'processing' | 'indexed' | 'failed',
	statusLabel: string,
	pages?: number
): Promise<void> {
	const db = getDb();
	if (!db) return;
	await db
		.update(schema.documents)
		.set({ status, statusLabel, ...(pages && pages > 0 ? { pages } : {}) })
		.where(eq(schema.documents.id, documentId));
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

/** The stage machine — cancellation-aware; throws IngestionCancelledError. */
async function executePipeline(job: IngestionJob): Promise<void> {
	const report = async (stage: string, progress: number, message: string) => {
		const e = { documentId: job.documentId, documentTitle: job.documentTitle, stage, progress, message };
		emit(e);
		await persistProgress(e).catch(() => {});
	};

	// Cooperative cancellation checkpoint: re-read the processing_jobs row and
	// abort when the cancel endpoint marked it 'failed'.
	const checkpoint = async () => {
		const cancelled = await isJobCancelled(job.documentId).catch(() => false);
		if (cancelled) throw new IngestionCancelledError();
	};

	// Tenant scoping: org settings pick the parse mode + SSOT auto-compile
	// policy, and orgId routes BYO keys/budget for every embed call below.
	const ctx = await resolveOrgContext(job.documentId);
	const settings = await getOrgSettings(ctx.orgId).catch(() => null);
	const autoSsot = settings?.autoSsotTopics ?? true;

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
		await markDocumentStatus(job.documentId, 'indexed', 'Indexed (metadata only)').catch(() => {});
		emitDocumentEvent(
			ctx,
			job,
			'indexed',
			{ pages: 0, chunks: 0, claims: 0, metadataOnly: true },
			`"${job.documentTitle}" indexed (metadata only — no extractable text)`
		);
		return;
	}

	// 2. Parse — structure-aware pages + blocks with coverage accounting.
	await checkpoint();
	await report('parse', 28, 'Parsing structure (pages, blocks)');
	let parsed: ParsedDoc;
	if (bytes && job.storageKey) {
		parsed = await parseDocument(bytes, job.storageKey, { orgId: ctx.orgId }).catch(() => ({
			pages: [{ pageNo: 1 }],
			blocks: [],
			text: text as string
		}));
	} else {
		parsed = { pages: [{ pageNo: 1 }], blocks: [], text };
	}
	await persistParsed(job.documentId, parsed).catch(() => {});

	// 3. Chunk (page-attributed)
	await checkpoint();
	await report('chunk', 45, 'Splitting into semantic chunks');
	const metaChunks = buildMetaChunks(job.documentId, parsed);

	// 4. Contextualize (Anthropic contextual retrieval — skipped without a provider)
	await checkpoint();
	await report('contextualize', 58, 'Adding contextual prefixes');
	const prefixes = await contextualizeChunks(job.documentTitle, metaChunks.map((c) => c.content));
	metaChunks.forEach((c, i) => (c.context = prefixes[i]));

	// 5. Embed (context + content) — the longest paid stage, so also check for
	//    cancellation periodically inside the loop.
	await checkpoint();
	await report('embed', 74, `Computing embeddings for ${metaChunks.length} chunks`);
	for (let i = 0; i < metaChunks.length; i++) {
		if (i > 0 && i % 25 === 0) await checkpoint();
		const c = metaChunks[i];
		const toEmbed = c.context ? `${c.context}\n${c.content}` : c.content;
		c.embedding = await embedText(toEmbed, { orgId: ctx.orgId });
	}

	// 6. Index (FTS + pgvector)
	await checkpoint();
	await report('index', 88, 'Writing FTS + pgvector index');
	await indexChunks(job.documentId, metaChunks);
	await markChunkedCoverage(job.documentId).catch(() => {});

	// 7+8. Refinery — claim extraction + correlation compile the SSOT topic
	// layer. Honors the org setting autoSsotTopics (admin General settings):
	// when off, documents are searchable (chunks indexed above) but no topics/
	// claims/graph are auto-compiled from them.
	let claimRes = { extracted: 0, topics: 0 };
	let corr = { merged: 0, conflicts: 0, triples: 0, versioned: 0 };
	if (autoSsot) {
		// 7. Extract claims (refinery) — ontology-linked, topic-routed. Skipped
		//    silently when no provider is configured.
		await checkpoint();
		await report('claims', 92, 'Extracting atomic claims');
		claimRes = await extractClaimsForDocument(job.documentId, ctx.orgId).catch((e) => {
			console.error('[ingest] claim extraction failed:', e instanceof Error ? e.message : e);
			return { extracted: 0, topics: 0 };
		});
		await markClaimedCoverage(job.documentId).catch(() => {});

		// 8. Correlate — dedup, conflict detection, graph triples, topic versions.
		await checkpoint();
		await report('correlate', 97, 'Deduplicating, detecting conflicts, building graph');
		corr = await correlateDocument(job.documentId, ctx.orgId).catch((e) => {
			console.error('[ingest] correlation failed:', e instanceof Error ? e.message : e);
			return { merged: 0, conflicts: 0, triples: 0, versioned: 0 };
		});
	}

	const summary = autoSsot
		? `Indexed ${metaChunks.length} chunks / ${parsed.pages.length} pages · ${claimRes.extracted} claims · ` +
			`${corr.merged} merged · ${corr.conflicts} conflicts · ${corr.triples} graph edges`
		: `Indexed ${metaChunks.length} chunks / ${parsed.pages.length} pages · SSOT auto-compile off (org setting)`;
	await report('done', 100, summary);
	await markDocumentStatus(job.documentId, 'indexed', 'Indexed', parsed.pages.length).catch(
		() => {}
	);
	emitDocumentEvent(
		ctx,
		job,
		'indexed',
		{
			pages: parsed.pages.length,
			chunks: metaChunks.length,
			claims: claimRes.extracted,
			merged: corr.merged,
			conflicts: corr.conflicts,
			graphEdges: corr.triples,
			ssotCompiled: autoSsot
		},
		`"${job.documentTitle}" — ${summary}`
	);
}

/**
 * Run the pipeline and settle the document's final status. Never throws:
 * failures mark the document 'failed' (with a persisted failed stage) instead
 * of bubbling into pg-boss retries that would flip the status back to
 * 'processing'; cancellations leave the row on 'failed / Cancelled by user'.
 */
export async function runIngestion(job: IngestionJob): Promise<void> {
	try {
		await executePipeline(job);
	} catch (e) {
		if (e instanceof IngestionCancelledError) {
			console.info(`[ingest] cancelled by user: ${job.documentTitle}`);
			await markDocumentStatus(job.documentId, 'failed', 'Cancelled').catch(() => {});
			// Machine consumers still learn the document will not index; no human
			// notification — the cancellation was user-initiated.
			const ctx = await resolveOrgContext(job.documentId);
			void dispatchWebhooks(ctx.orgId, 'document.failed', {
				documentId: job.documentId,
				title: job.documentTitle,
				reason: 'cancelled'
			}).catch(() => {});
			return;
		}
		const message = e instanceof Error ? e.message : String(e);
		console.error(`[ingest] pipeline failed for ${job.documentTitle}:`, message);
		await persistProgress({
			documentId: job.documentId,
			documentTitle: job.documentTitle,
			stage: 'failed',
			progress: 100,
			message: `Failed: ${message}`
		}).catch(() => {});
		await markDocumentStatus(job.documentId, 'failed', 'Processing failed').catch(() => {});
		const ctx = await resolveOrgContext(job.documentId);
		emitDocumentEvent(
			ctx,
			job,
			'failed',
			{ reason: message.slice(0, 300) },
			`"${job.documentTitle}" failed to process: ${message.slice(0, 200)}`
		);
	}
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

/**
 * Best-effort pg-boss cancellation (stops jobs still sitting in the queue; a
 * job already being worked aborts at its next cooperative checkpoint instead).
 */
export async function cancelBossJob(bossJobId: string): Promise<boolean> {
	const b = await getBoss();
	if (!b) return false;
	await b.cancel(INGESTION_QUEUE, bossJobId);
	return true;
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
	// Fresh enqueue/retry: the document is honestly 'processing' again.
	await markDocumentStatus(job.documentId, 'processing', 'Processing (queued)').catch(() => {});
	const b = await getBoss();
	if (b) {
		const bossJobId: string | null = await b.send(INGESTION_QUEUE, job);
		if (bossJobId) await setBossJobId(job.documentId, bossJobId).catch(() => {});
	} else {
		void runIngestion(job); // fire-and-forget inline in dev
	}
}
