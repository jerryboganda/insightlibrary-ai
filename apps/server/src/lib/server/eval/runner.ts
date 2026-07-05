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
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { evalRuns } from '../db/schema';
import { getRepository } from '../data';
import { loadGolden } from './golden';
import type { EvaluationMetrics } from '@insightlibrary/schemas';

const round = (n: number) => Math.round(n * 100) / 100;

export async function runGoldenEval(orgId = 'org_1'): Promise<EvaluationMetrics> {
	const repo = getRepository();
	const golden = loadGolden();
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
		faithfulness: round(faithfulness),
		citationAccuracy: round(recall),
		hallucinationRate: round(1 - faithfulness),
		noveltyPrecision: round(noveltyPrecision),
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
