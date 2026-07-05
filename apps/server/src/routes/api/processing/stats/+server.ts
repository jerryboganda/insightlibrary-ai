import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { getRepository } from '$lib/server/data';

/**
 * GET /api/processing/stats — real pipeline rollups (gap B16), replacing the
 * fabricated "OCR Success Rate 98.2% / Total Chunks 142k / Avg Process Time"
 * cards. Sources:
 *  - processing_jobs: stage buckets, success ratio, 24h throughput, and average
 *    durations from the per-stage timestamps persisted by processing-store.ts
 *    (stages jsonb, migration 0011 — nulls before it applies, never fakes).
 *  - documents/chunks/claims: org-scoped corpus counts.
 * Memory mode degrades to seed-repo job/document counts with null timings.
 */

const TERMINAL = new Set(['queued', 'done', 'failed']);

interface StageMap {
	[stage: string]: string;
}

/** Average per-stage durations from chronologically ordered stage timestamps. */
function stageDurations(rows: StageMap[]): Record<string, number> | null {
	const sums = new Map<string, { total: number; n: number }>();
	for (const stages of rows) {
		const entries = Object.entries(stages)
			.map(([stage, ts]) => ({ stage, at: Date.parse(ts) }))
			.filter((e) => Number.isFinite(e.at))
			.sort((a, b) => a.at - b.at);
		for (let i = 0; i < entries.length - 1; i++) {
			const cur = entries[i];
			const durMs = entries[i + 1].at - cur.at;
			if (durMs < 0) continue;
			const acc = sums.get(cur.stage) ?? { total: 0, n: 0 };
			acc.total += durMs;
			acc.n += 1;
			sums.set(cur.stage, acc);
		}
	}
	if (!sums.size) return null;
	const out: Record<string, number> = {};
	for (const [stage, acc] of sums) out[stage] = Math.round(acc.total / acc.n);
	return out;
}

export const GET: RequestHandler = async ({ locals }) => {
	const db = getDb();
	const orgId = locals.user?.orgId || 'org_1';

	// ── Memory mode: honest seed-repo counts, no invented timings ─────────────
	if (!db) {
		const repo = getRepository();
		const jobs = await repo.listProcessing();
		const docs = await repo.listDocuments();
		const byStage: Record<string, number> = {};
		for (const j of jobs) byStage[j.stage] = (byStage[j.stage] ?? 0) + 1;
		const completed = byStage['done'] ?? 0;
		const failed = byStage['failed'] ?? 0;
		const byStatus: Record<string, number> = {};
		for (const d of docs) byStatus[d.status] = (byStatus[d.status] ?? 0) + 1;
		return json({
			source: 'memory',
			jobs: {
				total: jobs.length,
				queued: byStage['queued'] ?? 0,
				active: jobs.filter((j) => !TERMINAL.has(j.stage)).length,
				completed,
				failed,
				byStage
			},
			documents: { total: docs.length, byStatus },
			chunks: null,
			claims: null,
			successRate: completed + failed > 0 ? completed / (completed + failed) : null,
			avgDurationMs: null,
			avgStageDurationsMs: null,
			throughput24h: { completed: 0, failed: 0 }
		});
	}

	// ── Job stage buckets (global — processing_jobs carries no org column) ────
	const byStage: Record<string, number> = {};
	const stageRes = await db.execute<{ stage: string; n: number }>(
		sql`SELECT stage, COUNT(*)::int AS n FROM processing_jobs GROUP BY stage`
	);
	for (const r of stageRes.rows) byStage[r.stage] = Number(r.n);
	const totalJobs = Object.values(byStage).reduce((s, n) => s + n, 0);
	const completed = byStage['done'] ?? 0;
	const failed = byStage['failed'] ?? 0;
	const queued = byStage['queued'] ?? 0;
	const active = totalJobs - completed - failed - queued;

	// ── Org-scoped corpus counts ───────────────────────────────────────────────
	const byStatus: Record<string, number> = {};
	let totalDocs = 0;
	const docRes = await db.execute<{ status: string; n: number }>(sql`
		SELECT d.status, COUNT(*)::int AS n
		FROM documents d JOIN folders f ON f.id = d.folder_id
		WHERE f.org_id = ${orgId}
		GROUP BY d.status
	`);
	for (const r of docRes.rows) {
		byStatus[r.status] = Number(r.n);
		totalDocs += Number(r.n);
	}
	const chunkRes = await db.execute<{ n: number }>(sql`
		SELECT COUNT(*)::int AS n
		FROM chunks c JOIN documents d ON d.id = c.document_id JOIN folders f ON f.id = d.folder_id
		WHERE f.org_id = ${orgId}
	`);
	const chunks = Number(chunkRes.rows[0]?.n ?? 0);
	let claims: number | null = null;
	try {
		const claimRes = await db.execute<{ n: number }>(
			sql`SELECT COUNT(*)::int AS n FROM claims WHERE org_id = ${orgId}`
		);
		claims = Number(claimRes.rows[0]?.n ?? 0);
	} catch {
		claims = null; // claims table not migrated on this deployment
	}

	// ── Timings + throughput from per-stage timestamps (0011; null before it) ──
	let avgDurationMs: number | null = null;
	let avgStageDurationsMs: Record<string, number> | null = null;
	let throughput24h = { completed: 0, failed: 0 };
	try {
		const avgRes = await db.execute<{ avg_ms: number | null }>(sql`
			SELECT (AVG(EXTRACT(EPOCH FROM (
				(stages->>'done')::timestamptz - COALESCE((stages->>'queued')::timestamptz, (stages->>'extract')::timestamptz)
			))) * 1000)::float8 AS avg_ms
			FROM processing_jobs
			WHERE stages->>'done' IS NOT NULL
			  AND COALESCE(stages->>'queued', stages->>'extract') IS NOT NULL
		`);
		const avg = avgRes.rows[0]?.avg_ms;
		avgDurationMs = avg === null || avg === undefined ? null : Math.round(Number(avg));

		const tpRes = await db.execute<{ completed: number; failed: number }>(sql`
			SELECT
				COUNT(*) FILTER (WHERE stage = 'done'
					AND COALESCE((stages->>'done')::timestamptz, started_at) >= now() - interval '24 hours')::int AS completed,
				COUNT(*) FILTER (WHERE stage = 'failed'
					AND COALESCE((stages->>'failed')::timestamptz, started_at) >= now() - interval '24 hours')::int AS failed
			FROM processing_jobs
		`);
		throughput24h = {
			completed: Number(tpRes.rows[0]?.completed ?? 0),
			failed: Number(tpRes.rows[0]?.failed ?? 0)
		};

		const stagesRes = await db.execute<{ stages: StageMap | string }>(sql`
			SELECT stages FROM processing_jobs
			WHERE stage = 'done' AND stages->>'done' IS NOT NULL
			ORDER BY started_at DESC
			LIMIT 200
		`);
		avgStageDurationsMs = stageDurations(
			stagesRes.rows.map((r) => (typeof r.stages === 'string' ? (JSON.parse(r.stages) as StageMap) : r.stages))
		);
	} catch {
		// stages column not migrated yet — timings stay null (never fabricated).
	}

	return json({
		source: 'postgres',
		jobs: { total: totalJobs, queued, active, completed, failed, byStage },
		documents: { total: totalDocs, byStatus },
		chunks,
		claims,
		successRate: completed + failed > 0 ? completed / (completed + failed) : null,
		avgDurationMs,
		avgStageDurationsMs,
		throughput24h
	});
};
