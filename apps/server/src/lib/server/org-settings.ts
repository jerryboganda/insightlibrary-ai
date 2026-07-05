/**
 * Org-scoped settings store (org_settings table) — the single seam through
 * which admin-manageable configuration reaches the runtime:
 *
 *  - Workspace identity: name + logo (small data: URL for now).
 *  - Governance/refinery thresholds (dedup, conflict, correlation caps).
 *  - Ingestion pipeline knobs (parse mode, chunk caps, rerank backend).
 *  - Search/generation constants (RRF K, candidate/top-K, snippet length,
 *    per-mode copilot system-prompt overrides).
 *
 * Every value has an env-var default (mirroring the previous hardcoded
 * behavior), so deployments without a stored override behave exactly as
 * before. Stored overrides win over env. Reads are cached in-process with a
 * short TTL so hot paths (search, refinery jobs) stay cheap while admin edits
 * apply within seconds — no restart, in BOTH the SvelteKit runtime and the
 * standalone pg-boss worker (this module uses getDb()/process.env only).
 */
import { eq } from 'drizzle-orm';
import { getDb } from './db/client';
import { organizations, orgSettings } from './db/schema';

export const PARSE_MODES = ['heuristic', 'document-ai', 'external'] as const;
export const RERANK_MODES = ['off', 'llm', 'cohere', 'jina'] as const;
export type ParseMode = (typeof PARSE_MODES)[number];
export type RerankMode = (typeof RERANK_MODES)[number];

export interface OrgSettingsValues {
	// ── General workspace defaults (C1) ──────────────────────────────────────
	/** Default copilot answering policy surfaced to clients. */
	strictCitationDefault: boolean;
	/** Auto-compile SSOT topics from new document uploads. */
	autoSsotTopics: boolean;
	// ── Governance / refinery (C2) ────────────────────────────────────────────
	/** Freeze contradicting claims as 'conflicted' until a human resolves them. */
	requireReview: boolean;
	/** NLI equivalence confidence (0–100) required before auto-merging duplicates. 0 = always merge. */
	autoMergeConfidence: number;
	/** Cosine similarity above which two claims are dedup candidates. */
	dedupCosine: number;
	/** Gate dedup on an LLM equivalence (NLI) check in addition to cosine. */
	dedupUseNli: boolean;
	/** Cosine above which two claims are considered the same subject (conflict). */
	conflictSubjectCosine: number;
	conflictEnabled: boolean;
	/** Max claims per document to correlate (cost guard). */
	maxCorrelateClaims: number;
	// ── Ingestion pipeline (C3) ───────────────────────────────────────────────
	parseMode: ParseMode;
	parseAiMaxPages: number;
	claimsMaxChunks: number;
	contextualMaxChunks: number;
	ontologyLinkMaxDistance: number;
	/** Rerank backend: off | llm | cohere | jina (vendor keys stay env-side). */
	rerank: RerankMode;
	// ── Search / generation (C11) ─────────────────────────────────────────────
	/** Reciprocal Rank Fusion constant. */
	searchRrfK: number;
	/** Candidates fetched per retrieval arm (FTS / vector). */
	searchCandidates: number;
	/** Fused chunk results returned to the client. */
	searchTopK: number;
	/** Snippet length (chars) in search results. */
	searchSnippetLength: number;
	/** Per-mode copilot system-prompt overrides (empty = built-in prompt). */
	copilotPromptOverrides: Record<string, string>;
	/** Admin-ranked source-tier ordering (workspace policy). */
	sourcePriorityOrder: string[];
	// ── FinOps budget (C6) — enforced by the AI provider router ──────────────
	/** Monthly hard AI-spend limit in USD. 0 = unlimited (no enforcement). */
	budgetMonthlyLimitUsd: number;
	/** % of the hard limit at which a soft-alert audit event fires (0 disables). */
	budgetSoftThresholdPct: number;
}

export interface ResolvedOrgSettings extends OrgSettingsValues {
	orgId: string;
	/** Workspace display name (org_settings.name ?? organizations.name). */
	name: string | null;
	/** Workspace logo (data: URL) or null. */
	logo: string | null;
	/** Keys with a stored override (everything else is the env default). */
	overridden: (keyof OrgSettingsValues)[];
	updatedAt: string | null;
}

export interface OrgSettingsUpdate {
	name?: string;
	/** data:image/* URL to set, null to clear, undefined to leave unchanged. */
	logo?: string | null;
	/** Per-key overrides; null clears a key back to its env default. */
	settings?: { [K in keyof OrgSettingsValues]?: OrgSettingsValues[K] | null };
}

// ── Env defaults (identical to the previously hardcoded/env-only behavior) ──

function envRaw(name: string): string | undefined {
	const v = process.env[name];
	return v === undefined || v === '' ? undefined : v;
}
function envNum(name: string, fallback: number): number {
	const raw = envRaw(name);
	if (raw === undefined) return fallback;
	const n = Number(raw);
	return Number.isFinite(n) ? n : fallback;
}
function envBool(name: string, fallback: boolean): boolean {
	const raw = envRaw(name);
	if (raw === undefined) return fallback;
	return raw !== 'false' && raw !== '0';
}
function envEnum<T extends string>(name: string, values: readonly T[], fallback: T): T {
	const raw = envRaw(name);
	return raw !== undefined && (values as readonly string[]).includes(raw) ? (raw as T) : fallback;
}
function clamp(n: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, n));
}
function clampInt(n: number, min: number, max: number): number {
	return clamp(Math.round(n), min, max);
}

/** Base defaults from env vars — what the system uses with no stored override. */
export function orgSettingsDefaults(): OrgSettingsValues {
	return {
		strictCitationDefault: envBool('STRICT_CITATION_DEFAULT', true),
		autoSsotTopics: envBool('AUTO_SSOT_TOPICS', true),
		requireReview: envBool('REQUIRE_REVIEW', true),
		autoMergeConfidence: clamp(envNum('AUTO_MERGE_CONFIDENCE', 0), 0, 100),
		dedupCosine: clamp(envNum('DEDUP_COSINE', 0.9), 0, 1),
		dedupUseNli: envBool('DEDUP_NLI', true),
		conflictSubjectCosine: clamp(envNum('CONFLICT_SUBJECT_COSINE', 0.55), 0, 1),
		conflictEnabled: envBool('CONFLICT_DETECT', true),
		maxCorrelateClaims: clampInt(envNum('CORRELATE_MAX_CLAIMS', 120), 1, 5000),
		parseMode: envEnum<ParseMode>('PARSE_MODE', PARSE_MODES, 'heuristic'),
		parseAiMaxPages: clampInt(envNum('PARSE_AI_MAX_PAGES', 20), 1, 500),
		claimsMaxChunks: clampInt(envNum('CLAIMS_MAX_CHUNKS', 60), 1, 2000),
		contextualMaxChunks: clampInt(envNum('CONTEXTUAL_MAX_CHUNKS', 150), 0, 5000),
		ontologyLinkMaxDistance: clamp(envNum('ONTOLOGY_LINK_MAX_DISTANCE', 0.4), 0, 1),
		rerank: envEnum<RerankMode>('RERANK', RERANK_MODES, 'off'),
		searchRrfK: clampInt(envNum('SEARCH_RRF_K', 60), 1, 500),
		searchCandidates: clampInt(envNum('SEARCH_CANDIDATES', 30), 5, 200),
		searchTopK: clampInt(envNum('SEARCH_TOP_K', 20), 1, 100),
		searchSnippetLength: clampInt(envNum('SEARCH_SNIPPET_LENGTH', 240), 80, 2000),
		copilotPromptOverrides: {},
		sourcePriorityOrder: [],
		budgetMonthlyLimitUsd: clamp(envNum('BUDGET_MONTHLY_LIMIT_USD', 0), 0, 10_000_000),
		budgetSoftThresholdPct: clamp(envNum('BUDGET_SOFT_THRESHOLD_PCT', 80), 0, 100)
	};
}

// ── Stored-value sanitizers (defensive: a poisoned row must never crash jobs) ─

type Sanitizer = (v: unknown) => unknown | undefined;

const bool: Sanitizer = (v) => (typeof v === 'boolean' ? v : undefined);
const num =
	(min: number, max: number, int = false): Sanitizer =>
	(v) => {
		if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
		return int ? clampInt(v, min, max) : clamp(v, min, max);
	};
const oneOf =
	(values: readonly string[]): Sanitizer =>
	(v) => (typeof v === 'string' && values.includes(v) ? v : undefined);
const stringMap: Sanitizer = (v) => {
	if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
	const out: Record<string, string> = {};
	for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
		if (typeof val === 'string' && val.trim() && val.length <= 4000) out[k] = val;
	}
	return out;
};
const stringList: Sanitizer = (v) => {
	if (!Array.isArray(v)) return undefined;
	return v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200).slice(0, 100);
};

const SANITIZERS: Record<keyof OrgSettingsValues, Sanitizer> = {
	strictCitationDefault: bool,
	autoSsotTopics: bool,
	requireReview: bool,
	autoMergeConfidence: num(0, 100),
	dedupCosine: num(0, 1),
	dedupUseNli: bool,
	conflictSubjectCosine: num(0, 1),
	conflictEnabled: bool,
	maxCorrelateClaims: num(1, 5000, true),
	parseMode: oneOf(PARSE_MODES),
	parseAiMaxPages: num(1, 500, true),
	claimsMaxChunks: num(1, 2000, true),
	contextualMaxChunks: num(0, 5000, true),
	ontologyLinkMaxDistance: num(0, 1),
	rerank: oneOf(RERANK_MODES),
	searchRrfK: num(1, 500, true),
	searchCandidates: num(5, 200, true),
	searchTopK: num(1, 100, true),
	searchSnippetLength: num(80, 2000, true),
	copilotPromptOverrides: stringMap,
	sourcePriorityOrder: stringList,
	budgetMonthlyLimitUsd: num(0, 10_000_000),
	budgetSoftThresholdPct: num(0, 100)
};

export const ORG_SETTING_KEYS = Object.keys(SANITIZERS) as (keyof OrgSettingsValues)[];

// ── Read path (short-TTL cache; never throws — degrades to env defaults) ────

const TTL_MS = 10_000;
const cache = new Map<string, { at: number; value: ResolvedOrgSettings }>();

export function invalidateOrgSettings(orgId?: string): void {
	if (orgId) cache.delete(orgId);
	else cache.clear();
}

export async function getOrgSettings(orgId = 'org_1'): Promise<ResolvedOrgSettings> {
	const hit = cache.get(orgId);
	if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

	const resolved: ResolvedOrgSettings = {
		orgId,
		name: null,
		logo: null,
		overridden: [],
		updatedAt: null,
		...orgSettingsDefaults()
	};

	const db = getDb();
	if (db) {
		try {
			const [row] = await db.select().from(orgSettings).where(eq(orgSettings.orgId, orgId));
			if (row) {
				resolved.name = row.name ?? null;
				resolved.logo = row.logoKey ?? null;
				resolved.updatedAt = row.updatedAt.toISOString();
				const stored = (row.settings ?? {}) as Record<string, unknown>;
				for (const key of ORG_SETTING_KEYS) {
					if (!(key in stored)) continue;
					const clean = SANITIZERS[key](stored[key]);
					if (clean !== undefined) {
						(resolved as unknown as Record<string, unknown>)[key] = clean;
						resolved.overridden.push(key);
					}
				}
			}
			if (!resolved.name) {
				const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
				if (org) resolved.name = org.name;
			}
		} catch (e) {
			// Table missing / transient DB blip → env defaults, never a crash.
			console.error('[org-settings] read failed:', e instanceof Error ? e.message : e);
		}
	}

	cache.set(orgId, { at: Date.now(), value: resolved });
	return resolved;
}

// ── Write path (admin endpoint only) ─────────────────────────────────────────

export async function updateOrgSettings(orgId: string, patch: OrgSettingsUpdate): Promise<ResolvedOrgSettings> {
	const db = getDb();
	if (!db) throw new Error('Database required to persist org settings');

	// FK guard: better-auth orgs are not yet mirrored into the app organizations
	// table (see C10) — ensure a minimal row exists before referencing it.
	await db
		.insert(organizations)
		.values({ id: orgId, name: patch.name ?? orgId, slug: orgId, tenantId: orgId })
		.onConflictDoNothing();

	const [existing] = await db.select().from(orgSettings).where(eq(orgSettings.orgId, orgId));
	const merged: Record<string, unknown> = { ...((existing?.settings ?? {}) as Record<string, unknown>) };
	for (const [key, raw] of Object.entries(patch.settings ?? {})) {
		if (!ORG_SETTING_KEYS.includes(key as keyof OrgSettingsValues)) continue;
		if (raw === null) {
			delete merged[key];
			continue;
		}
		const clean = SANITIZERS[key as keyof OrgSettingsValues](raw);
		if (clean !== undefined) merged[key] = clean;
	}

	const name = patch.name !== undefined ? patch.name : (existing?.name ?? null);
	const logoKey = patch.logo !== undefined ? patch.logo : (existing?.logoKey ?? null);
	const updatedAt = new Date();

	await db
		.insert(orgSettings)
		.values({ orgId, name, logoKey, settings: merged, updatedAt })
		.onConflictDoUpdate({
			target: orgSettings.orgId,
			set: { name, logoKey, settings: merged, updatedAt }
		});

	// Keep the canonical org row's display name in sync.
	if (patch.name) {
		await db.update(organizations).set({ name: patch.name }).where(eq(organizations.id, orgId));
	}

	invalidateOrgSettings(orgId);
	return getOrgSettings(orgId);
}
