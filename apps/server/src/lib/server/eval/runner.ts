/**
 * Golden-set eval runner. Computes real metrics and persists them:
 *  - citationAccuracy = retrieval recall over the golden set (did we surface the
 *    expected source/term for each question).
 *  - faithfulness = mean composed-topic faithfulness (from topic_versions, the
 *    verifier's supported/total), falling back to recall.
 *  - hallucinationRate = 1 − faithfulness.
 *  - noveltyPrecision = dedup precision proxy = active / (active + superseded),
 *    i.e. the outcome of Correlation's dedup (its thresholds live in refinery/config.ts;
 *    this harness measures the already-merged result, so no threshold is re-applied here).
 */
import { desc, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { evalRuns } from '../db/schema';
import { getRepository } from '../data';
import { loadGoldenSet } from './golden-store';
import type { EvaluationMetrics } from '@insightlibrary/schemas';

/**
 * The four headline metrics are stored and surfaced on a PERCENTAGE scale
 * (0–100), matching the dashboard cards (`${value}%`) and the seed fallback.
 * The underlying computations are fractions (0–1), so pct() scales them. The
 * per-test `faithfulness` stays 0–1 (the table renders it with .toFixed(2)).
 */
const pct = (fraction: number) => Math.round(fraction * 1000) / 10;

export async function runGoldenEval(orgId = 'org_1'): Promise<EvaluationMetrics> {
	const repo = getRepository();
	// Admin-managed golden set (DB, seeded from the bundle on first run); falls
	// back to the bundled file when the table is empty / DB is unavailable.
	const golden = await loadGoldenSet(orgId);
	const recentTests: EvaluationMetrics['recentTests'] = [];
	let hits = 0;

	for (const g of golden) {
		const { results } = await repo.search(g.query);
		const hit = results.some((r) => `${r.snippet} ${r.title}`.toLowerCase().includes(g.expect.toLowerCase()));
		if (hit) hits++;
		recentTests.push({ query: g.query, mode: 'strict_citation', status: hit ? 'Pass' : 'Fail', faithfulness: hit ? 1 : 0 });
	}
	const recall = golden.length ? hits / golden.length : 0;

	let faithfulness = recall;
	let noveltyPrecision = recall;
	const db = getDb();
	if (db) {
		const statusRows = await db.execute<{ status: string; n: number }>(
			sql`SELECT status, count(*)::int AS n FROM claims WHERE org_id = ${orgId} GROUP BY status`
		);
		let active = 0;
		let superseded = 0;
		for (const r of statusRows.rows) {
			if (r.status === 'active') active = Number(r.n);
			if (r.status === 'superseded') superseded = Number(r.n);
		}
		if (active + superseded > 0) noveltyPrecision = active / (active + superseded);

		const fRows = await db.execute<{ avg: number | null }>(
			sql`SELECT avg(faithfulness) AS avg FROM topic_versions WHERE org_id = ${orgId} AND faithfulness IS NOT NULL`
		);
		const avg = fRows.rows[0]?.avg;
		if (avg != null) faithfulness = Number(avg);
	}

	const metrics: EvaluationMetrics = {
		faithfulness: pct(faithfulness),
		citationAccuracy: pct(recall),
		hallucinationRate: pct(1 - faithfulness),
		noveltyPrecision: pct(noveltyPrecision),
		recentTests: recentTests.slice(0, 10)
	};

	if (db) {
		await db.insert(evalRuns).values({
			id: `eval_${Date.now()}`,
			orgId,
			faithfulness: metrics.faithfulness,
			citationAccuracy: metrics.citationAccuracy,
			hallucinationRate: metrics.hallucinationRate,
			noveltyPrecision: metrics.noveltyPrecision,
			recentTests: metrics.recentTests
		});
	}
	return metrics;
}

/** One persisted eval run for the history/trend view (B34). Percentage-scaled. */
export interface EvalRunSummary {
	id: string;
	faithfulness: number;
	citationAccuracy: number;
	hallucinationRate: number;
	noveltyPrecision: number;
	createdAt: string;
}

/**
 * Most-recent persisted eval runs (newest first) for the evaluation dashboard's
 * real trend deltas. Empty when no DB / no runs — the UI then omits trend chips.
 */
export async function recentEvalRuns(orgId = 'org_1', limit = 10): Promise<EvalRunSummary[]> {
	const db = getDb();
	if (!db) return [];
	try {
		const rows = await db
			.select({
				id: evalRuns.id,
				faithfulness: evalRuns.faithfulness,
				citationAccuracy: evalRuns.citationAccuracy,
				hallucinationRate: evalRuns.hallucinationRate,
				noveltyPrecision: evalRuns.noveltyPrecision,
				createdAt: evalRuns.createdAt
			})
			.from(evalRuns)
			.where(sql`${evalRuns.orgId} = ${orgId}`)
			.orderBy(desc(evalRuns.createdAt))
			.limit(Math.min(Math.max(1, limit), 50));
		return rows.map((r) => ({
			id: r.id,
			faithfulness: r.faithfulness,
			citationAccuracy: r.citationAccuracy,
			hallucinationRate: r.hallucinationRate,
			noveltyPrecision: r.noveltyPrecision,
			createdAt: r.createdAt.toISOString()
		}));
	} catch (e) {
		console.error('[eval] recentEvalRuns failed:', e instanceof Error ? e.message : e);
		return [];
	}
}
