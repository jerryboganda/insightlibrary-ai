/**
 * AI usage metering + budget enforcement (gaps B17/C6).
 *
 * Every real (non-mock) AI call made through the provider router — and every
 * embedText() call — records a usage_events row: provider, model, task, token
 * estimates, estimated USD cost, org, optional user, timestamp. GET /api/usage
 * aggregates these rows live; the router calls enforceBudget() before spending.
 *
 * Design notes:
 *  - Fire-and-forget writes: metering must NEVER fail or slow an AI call.
 *  - Token counts are estimates (chars/4) — the provider adapters return plain
 *    text without usage metadata. Costs use a small per-model price map ($/1M
 *    tokens) with provider-level fallbacks; they are estimates for FinOps
 *    dashboards and budget guardrails, not billing-grade numbers.
 *  - The usage_events pgTable is defined here (migration 0010) because
 *    db/schema.ts is owned elsewhere; Drizzle's query builder works with any
 *    table object. Fold into db/schema.ts when convenient.
 *  - Worker-safe: getDb()/process.env only.
 */
import { sql } from 'drizzle-orm';
import { doublePrecision, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { getDb } from '../db/client';
import { usageMetrics } from '../db/schema';
import { getOrgSettings } from '../org-settings';
import { recordAudit } from '../audit';
import { BudgetExceededError } from '../ai/providers/types';

/** Per-call AI usage ledger (aggregated by GET /api/usage). Migration 0010. */
export const usageEvents = pgTable('usage_events', {
	id: text('id').primaryKey(),
	orgId: text('org_id').notNull(),
	userId: text('user_id'),
	provider: text('provider').notNull(),
	model: text('model').notNull().default(''),
	task: text('task').notNull().default('chat'),
	tokensIn: integer('tokens_in').notNull().default(0),
	tokensOut: integer('tokens_out').notNull().default(0),
	costUsd: doublePrecision('cost_usd').notNull().default(0),
	durationMs: integer('duration_ms').notNull().default(0),
	createdAt: timestamp('created_at').notNull().defaultNow()
});

// ── Cost estimation ─────────────────────────────────────────────────────────

/** ~4 chars per token — the standard rough heuristic. */
export function estimateTokens(chars: number): number {
	return Math.max(0, Math.ceil(chars / 4));
}

interface Price {
	in: number; // $ per 1M input tokens
	out: number; // $ per 1M output tokens
}

/** Model-name price map (first regex match wins). Estimates, not billing data. */
const MODEL_PRICES: Array<{ match: RegExp; price: Price }> = [
	{ match: /gemini-2\.5-flash-lite/i, price: { in: 0.1, out: 0.4 } },
	{ match: /gemini-2\.5-flash/i, price: { in: 0.3, out: 2.5 } },
	{ match: /gemini-2\.5-pro/i, price: { in: 1.25, out: 10 } },
	{ match: /gemini-embedding/i, price: { in: 0.15, out: 0 } },
	{ match: /claude.*opus/i, price: { in: 15, out: 75 } },
	{ match: /claude.*sonnet/i, price: { in: 3, out: 15 } },
	{ match: /claude.*haiku/i, price: { in: 0.8, out: 4 } },
	{ match: /gpt-4o-mini/i, price: { in: 0.15, out: 0.6 } },
	{ match: /gpt-4o/i, price: { in: 2.5, out: 10 } },
	{ match: /gpt-4\.1-mini/i, price: { in: 0.4, out: 1.6 } },
	{ match: /gpt-4\.1/i, price: { in: 2, out: 8 } },
	{ match: /text-embedding-3-small/i, price: { in: 0.02, out: 0 } },
	{ match: /text-embedding-3-large/i, price: { in: 0.13, out: 0 } },
	{ match: /deepseek/i, price: { in: 0.27, out: 1.1 } },
	{ match: /kimi|moonshot/i, price: { in: 0.6, out: 2.5 } },
	{ match: /minimax/i, price: { in: 0.2, out: 1.1 } }
];

const PROVIDER_FALLBACK_PRICES: Record<string, Price> = {
	gemini: { in: 0.3, out: 2.5 },
	anthropic: { in: 3, out: 15 },
	openai: { in: 2.5, out: 10 },
	deepseek: { in: 0.27, out: 1.1 },
	moonshot: { in: 0.6, out: 2.5 },
	minimax: { in: 0.2, out: 1.1 },
	'openai-compatible': { in: 1, out: 3 },
	// Consumer ChatGPT subscription (OAuth) — no org spend.
	'chatgpt-oauth': { in: 0, out: 0 }
};

export function priceFor(provider: string, model: string): Price {
	for (const { match, price } of MODEL_PRICES) if (match.test(model)) return price;
	return PROVIDER_FALLBACK_PRICES[provider] ?? { in: 1, out: 3 };
}

export function estimateCostUsd(provider: string, model: string, tokensIn: number, tokensOut: number): number {
	const p = priceFor(provider, model);
	return (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
}

// ── Recording ───────────────────────────────────────────────────────────────

export interface AiUsageEvent {
	orgId?: string | null;
	userId?: string | null;
	provider: string;
	model?: string;
	task?: string;
	/** Raw character counts — converted to token estimates when tokens absent. */
	charsIn?: number;
	charsOut?: number;
	tokensIn?: number;
	tokensOut?: number;
	/** Override the estimated cost (e.g. 0 for subscription-backed OAuth calls). */
	costUsd?: number;
	durationMs?: number;
}

let seq = 0;

/** Persist one AI usage event. Fire-and-forget: never throws, never blocks. */
export function recordAiUsage(ev: AiUsageEvent): void {
	const db = getDb();
	if (!db) return;
	const orgId = ev.orgId || 'org_1';
	const tokensIn = ev.tokensIn ?? estimateTokens(ev.charsIn ?? 0);
	const tokensOut = ev.tokensOut ?? estimateTokens(ev.charsOut ?? 0);
	const model = ev.model ?? '';
	const costUsd = ev.costUsd ?? estimateCostUsd(ev.provider, model, tokensIn, tokensOut);
	seq = (seq + 1) % 1_000_000;
	const id = `ue_${Date.now().toString(36)}_${seq.toString(36)}`;

	// Optimistic spend-cache bump so budget checks react before the next requery.
	const cached = spendCache.get(orgId);
	if (cached) cached.valueUsd += costUsd;

	void db
		.insert(usageEvents)
		.values({
			id,
			orgId,
			userId: ev.userId ?? null,
			provider: ev.provider,
			model,
			task: ev.task ?? 'chat',
			tokensIn,
			tokensOut,
			costUsd,
			durationMs: Math.max(0, Math.round(ev.durationMs ?? 0))
		})
		.catch((e) => {
			console.error('[metering] failed to record usage event:', e instanceof Error ? e.message : e);
		});
}

// ── Budget enforcement (C6) ─────────────────────────────────────────────────

const SPEND_TTL_MS = 30_000;
const spendCache = new Map<string, { at: number; valueUsd: number }>();
const AUDIT_THROTTLE_MS = 60 * 60 * 1000;
const lastSoftAudit = new Map<string, number>();
const lastHardAudit = new Map<string, number>();

function monthStartUtc(now = new Date()): Date {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Current calendar-month estimated spend (USD) for an org. Cached ~30s. */
export async function getMonthSpend(orgId: string): Promise<number> {
	const hit = spendCache.get(orgId);
	if (hit && Date.now() - hit.at < SPEND_TTL_MS) return hit.valueUsd;
	const db = getDb();
	if (!db) return 0;
	let value = 0;
	try {
		const res = await db.execute<{ spend: number }>(
			sql`SELECT COALESCE(SUM(cost_usd), 0)::float8 AS spend FROM usage_events
			    WHERE org_id = ${orgId} AND created_at >= ${monthStartUtc()}`
		);
		value = Number(res.rows[0]?.spend ?? 0);
	} catch {
		// Table not migrated yet / transient blip → treat as no recorded spend.
		value = 0;
	}
	spendCache.set(orgId, { at: Date.now(), valueUsd: value });
	return value;
}

/**
 * Gate an imminent paid AI call against the org budget (org_settings):
 *  - spend ≥ hard limit  → BudgetExceededError (typed refusal, call never made)
 *  - spend ≥ soft %      → audit-log warning (throttled to 1/hour/org)
 * No limit configured (0) → no-op. Never blocks on metering-table absence.
 */
export async function enforceBudget(orgId: string, task: string): Promise<void> {
	const settings = await getOrgSettings(orgId).catch(() => null);
	const limit = settings?.budgetMonthlyLimitUsd ?? 0;
	if (!limit || limit <= 0) return;
	const spend = await getMonthSpend(orgId);
	if (spend >= limit) {
		const last = lastHardAudit.get(orgId) ?? 0;
		if (Date.now() - last > AUDIT_THROTTLE_MS) {
			lastHardAudit.set(orgId, Date.now());
			recordAudit({
				orgId,
				actor: 'system:budget',
				action: 'ai.budget.hard_limit_blocked',
				target: `task=${task} spend=$${spend.toFixed(2)} limit=$${limit.toFixed(2)}`,
				severity: 'critical'
			});
		}
		throw new BudgetExceededError(limit, spend);
	}
	const softPct = settings?.budgetSoftThresholdPct ?? 0;
	if (softPct > 0 && spend >= (limit * softPct) / 100) {
		const last = lastSoftAudit.get(orgId) ?? 0;
		if (Date.now() - last > AUDIT_THROTTLE_MS) {
			lastSoftAudit.set(orgId, Date.now());
			recordAudit({
				orgId,
				actor: 'system:budget',
				action: 'ai.budget.soft_threshold_reached',
				target: `spend=$${spend.toFixed(2)} threshold=${softPct}% of $${limit.toFixed(2)}`,
				severity: 'warning'
			});
		}
	}
}

// ── Aggregation for GET /api/usage (B17/B18) ────────────────────────────────

export type UsagePeriod = 'month' | 'all';

const TASK_LABELS: Record<string, string> = {
	chat: 'Copilot Queries',
	extraction: 'Claim & Triple Extraction',
	synthesis: 'Generation & Synthesis',
	nli: 'NLI Judgments',
	rerank: 'Reranking',
	embedding: 'Embeddings',
	search: 'Hybrid Searches'
};

export interface UsageSummary {
	// Legacy usageMetricsSchema shape (finops/usage pages) —
	monthlyBudget: number;
	currentSpend: number;
	queries: number;
	costPerQuery: number;
	activeUsers: number;
	storageGB: number;
	events: Array<{ name: string; count: number; cost: number }>;
	// Additive extensions —
	period: UsagePeriod;
	budget: {
		monthlyLimitUsd: number;
		softThresholdPct: number;
		spendThisMonthUsd: number;
		/** True when a hard limit is configured and the router enforces it. */
		enforced: boolean;
	};
	byProvider: Array<{
		provider: string;
		model: string;
		calls: number;
		tokensIn: number;
		tokensOut: number;
		costUsd: number;
	}>;
	/** Timestamp of the earliest metered event, or null when nothing metered yet. */
	meteredSince: string | null;
}

/**
 * Aggregate real metering rows into the usage dashboard payload.
 * Returns null when no database is configured (route falls back to the seed repo).
 */
export async function getUsageSummary(orgId: string, period: UsagePeriod): Promise<UsageSummary | null> {
	const db = getDb();
	if (!db) return null;

	const since = period === 'month' ? monthStartUtc() : new Date(0);
	const settings = await getOrgSettings(orgId).catch(() => null);

	// Seeded aggregate row — used only as fallback for budget display + storage.
	let seeded: { monthlyBudget: number; storageGb: number } | null = null;
	try {
		const [r] = await db
			.select({ monthlyBudget: usageMetrics.monthlyBudget, storageGb: usageMetrics.storageGb })
			.from(usageMetrics)
			.where(sql`${usageMetrics.orgId} = ${orgId}`);
		seeded = r ?? null;
	} catch {
		seeded = null;
	}

	let byTask: Array<{ task: string; calls: number; cost: number }> = [];
	let byProvider: UsageSummary['byProvider'] = [];
	let activeUsers = 0;
	let meteredSince: string | null = null;
	try {
		const taskRes = await db.execute<{ task: string; calls: number; cost: number }>(
			sql`SELECT task, COUNT(*)::int AS calls, COALESCE(SUM(cost_usd), 0)::float8 AS cost
			    FROM usage_events WHERE org_id = ${orgId} AND created_at >= ${since}
			    GROUP BY task ORDER BY cost DESC`
		);
		byTask = taskRes.rows.map((r) => ({ task: r.task, calls: Number(r.calls), cost: Number(r.cost) }));

		const provRes = await db.execute<{
			provider: string;
			model: string;
			calls: number;
			tokens_in: number;
			tokens_out: number;
			cost: number;
		}>(
			sql`SELECT provider, model, COUNT(*)::int AS calls,
			           COALESCE(SUM(tokens_in), 0)::float8 AS tokens_in,
			           COALESCE(SUM(tokens_out), 0)::float8 AS tokens_out,
			           COALESCE(SUM(cost_usd), 0)::float8 AS cost
			    FROM usage_events WHERE org_id = ${orgId} AND created_at >= ${since}
			    GROUP BY provider, model ORDER BY cost DESC`
		);
		byProvider = provRes.rows.map((r) => ({
			provider: r.provider,
			model: r.model,
			calls: Number(r.calls),
			tokensIn: Number(r.tokens_in),
			tokensOut: Number(r.tokens_out),
			costUsd: Number(r.cost)
		}));

		const metaRes = await db.execute<{ users: number; first: string | null }>(
			sql`SELECT COUNT(DISTINCT user_id)::int AS users, MIN(created_at)::text AS first
			    FROM usage_events WHERE org_id = ${orgId} AND created_at >= ${since} AND user_id IS NOT NULL`
		);
		activeUsers = Number(metaRes.rows[0]?.users ?? 0);
		const firstRes = await db.execute<{ first: string | null }>(
			sql`SELECT MIN(created_at)::text AS first FROM usage_events WHERE org_id = ${orgId}`
		);
		meteredSince = firstRes.rows[0]?.first ?? null;
	} catch {
		// usage_events not migrated yet → real aggregates are all zero.
	}

	const currentSpend = byTask.reduce((s, t) => s + t.cost, 0);
	const queries = byTask.reduce((s, t) => s + t.calls, 0);
	const spendThisMonthUsd = period === 'month' ? currentSpend : await getMonthSpend(orgId);

	// Storage: live relation sizes for the heavy tables; seeded value as fallback.
	let storageGB = seeded?.storageGb ?? 0;
	try {
		const sres = await db.execute<{ bytes: string }>(
			sql`SELECT (COALESCE(pg_total_relation_size('chunks'), 0)
			          + COALESCE(pg_total_relation_size('documents'), 0)
			          + COALESCE(pg_total_relation_size('doc_blocks'), 0)
			          + COALESCE(pg_total_relation_size('doc_pages'), 0))::text AS bytes`
		);
		const bytes = Number(sres.rows[0]?.bytes ?? 0);
		if (Number.isFinite(bytes) && bytes > 0) storageGB = Math.round((bytes / 1e9) * 100) / 100;
	} catch {
		/* keep fallback */
	}

	const limitConfigured = (settings?.budgetMonthlyLimitUsd ?? 0) > 0;
	const monthlyBudget = limitConfigured ? settings!.budgetMonthlyLimitUsd : (seeded?.monthlyBudget ?? 0);

	return {
		monthlyBudget,
		currentSpend: Math.round(currentSpend * 10000) / 10000,
		queries,
		costPerQuery: queries > 0 ? Math.round((currentSpend / queries) * 10000) / 10000 : 0,
		activeUsers,
		storageGB,
		events: byTask.map((t) => ({
			name: TASK_LABELS[t.task] ?? t.task,
			count: t.calls,
			cost: Math.round(t.cost * 10000) / 10000
		})),
		period,
		budget: {
			monthlyLimitUsd: settings?.budgetMonthlyLimitUsd ?? 0,
			softThresholdPct: settings?.budgetSoftThresholdPct ?? 0,
			spendThisMonthUsd: Math.round(spendThisMonthUsd * 10000) / 10000,
			enforced: limitConfigured
		},
		byProvider,
		meteredSince
	};
}
