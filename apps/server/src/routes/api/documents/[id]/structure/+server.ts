import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { getRepository } from '$lib/server/data';

/**
 * GET /api/documents/[id]/structure — the first reader for the doc_pages /
 * doc_blocks coverage accounting (gap A7). Returns:
 *  - pages: count + first-page dimensions from doc_pages
 *  - blocks: total + counts by kind (text/figure/table/…)
 *  - coverage: coverage_status rollup with unaccounted/chunked/claimed %
 *  - chunks: embedded-chunk count for the document
 *  - job: real pipeline state from processing_jobs (stage, progress, per-stage
 *    timestamps when migration 0011 has applied)
 *  - hasSource: whether a source file exists in object storage (drives the
 *    document page's View Source button)
 * Memory mode degrades to nulls — the UI shows "no data", never invented stats.
 */

function pct(n: number, total: number): number {
	return total > 0 ? Math.round((n / total) * 1000) / 10 : 0;
}

export const GET: RequestHandler = async ({ params }) => {
	const db = getDb();
	if (!db) {
		// Seed/memory repo carries no parse structure — degrade honestly.
		const doc = await getRepository().getDocument(params.id);
		if (!doc) throw error(404, 'Document not found');
		return json({
			source: 'memory',
			hasSource: false,
			pages: null,
			blocks: null,
			coverage: null,
			chunks: null,
			job: null
		});
	}

	const docRes = await db.execute<{ id: string; storage_key: string | null }>(
		sql`SELECT id, storage_key FROM documents WHERE id = ${params.id}`
	);
	const doc = docRes.rows[0];
	if (!doc) throw error(404, 'Document not found');

	// ── Pages: count + representative (first page) dimensions ─────────────────
	const pageRes = await db.execute<{ n: number; width: number | null; height: number | null }>(sql`
		SELECT COUNT(*)::int AS n,
		       (ARRAY_AGG(width ORDER BY page_no))[1]::float8 AS width,
		       (ARRAY_AGG(height ORDER BY page_no))[1]::float8 AS height
		FROM doc_pages WHERE document_id = ${params.id}
	`);
	const pageRow = pageRes.rows[0];
	const pageCount = Number(pageRow?.n ?? 0);

	// ── Blocks: counts by kind ─────────────────────────────────────────────────
	const kindRes = await db.execute<{ kind: string; n: number }>(sql`
		SELECT kind, COUNT(*)::int AS n FROM doc_blocks
		WHERE document_id = ${params.id} GROUP BY kind
	`);
	const byKind: Record<string, number> = {};
	let totalBlocks = 0;
	for (const r of kindRes.rows) {
		byKind[r.kind] = Number(r.n);
		totalBlocks += Number(r.n);
	}

	// ── Coverage accounting rollup ─────────────────────────────────────────────
	const covRes = await db.execute<{ coverage_status: string; n: number }>(sql`
		SELECT coverage_status, COUNT(*)::int AS n FROM doc_blocks
		WHERE document_id = ${params.id} GROUP BY coverage_status
	`);
	const byStatus: Record<string, number> = {};
	for (const r of covRes.rows) byStatus[r.coverage_status] = Number(r.n);

	// ── Chunk count (what actually reached the index) ──────────────────────────
	const chunkRes = await db.execute<{ n: number }>(
		sql`SELECT COUNT(*)::int AS n FROM chunks WHERE document_id = ${params.id}`
	);

	// ── Real pipeline state from processing_jobs ───────────────────────────────
	type JobRow = {
		stage: string;
		progress: number;
		message: string;
		started_at: string | Date | null;
		stages?: Record<string, string> | string | null;
	};
	let job: {
		id: string;
		stage: string;
		progress: number;
		message: string;
		startedAt: string | null;
		stages: Record<string, string> | null;
	} | null = null;
	const jobId = `pj_${params.id}`;
	try {
		const jobRes = await db.execute<JobRow>(sql`
			SELECT stage, progress, message, started_at, stages
			FROM processing_jobs WHERE id = ${jobId}
		`);
		const row = jobRes.rows[0];
		if (row) {
			const stages =
				typeof row.stages === 'string'
					? (JSON.parse(row.stages) as Record<string, string>)
					: (row.stages ?? null);
			job = {
				id: jobId,
				stage: row.stage,
				progress: Number(row.progress),
				message: row.message,
				startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
				stages
			};
		}
	} catch {
		// stages column not migrated yet (pre-0011) — retry without it.
		const jobRes = await db.execute<JobRow>(sql`
			SELECT stage, progress, message, started_at FROM processing_jobs WHERE id = ${jobId}
		`);
		const row = jobRes.rows[0];
		if (row) {
			job = {
				id: jobId,
				stage: row.stage,
				progress: Number(row.progress),
				message: row.message,
				startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
				stages: null
			};
		}
	}

	return json({
		source: 'postgres',
		hasSource: Boolean(doc.storage_key),
		pages:
			pageCount > 0
				? {
						count: pageCount,
						width: pageRow?.width != null ? Number(pageRow.width) : null,
						height: pageRow?.height != null ? Number(pageRow.height) : null
					}
				: { count: 0, width: null, height: null },
		blocks: { total: totalBlocks, byKind },
		coverage: {
			total: totalBlocks,
			byStatus,
			unaccountedPct: pct(byStatus['unaccounted'] ?? 0, totalBlocks),
			chunkedPct: pct(byStatus['chunked'] ?? 0, totalBlocks),
			claimedPct: pct(byStatus['claimed'] ?? 0, totalBlocks)
		},
		chunks: Number(chunkRes.rows[0]?.n ?? 0),
		job
	});
};
