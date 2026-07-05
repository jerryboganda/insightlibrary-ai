/**
 * Org-scoped AI routing state: the org's provider_settings row (defaultProvider
 * + task_routing) and its stored provider_keys, decrypted and cached in-process
 * with a short TTL (stale-while-revalidate).
 *
 * This is the seam that lets admin-stored BYO keys and task routing power EVERY
 * router call — copilot, refinery, ingestion, generation — without each call
 * site doing its own DB reads. It works in BOTH the SvelteKit runtime and the
 * standalone pg-boss worker (getDb()/process.env only; the worker needs
 * MASTER_ENCRYPTION_KEY in its env to decrypt stored keys, else it degrades to
 * env keys with a one-time warning).
 *
 * The synchronous accessor exists because refinery modules gate on the router's
 * sync `available(task)`; it serves the cached value and refreshes in the
 * background, so within one refresh cycle of process start (or an admin edit)
 * the sync view converges on the stored configuration.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { providerKeys, providerSettings } from '../../db/schema';
import { PROVIDERS, type ConfigurableProvider } from './config';
import { decryptSecret } from './crypto';
import { TASK_KINDS, type Credential, type TaskKind } from './types';

export interface OrgAiRouting {
	orgId: string;
	/** Admin-chosen workspace default provider (provider_settings.default_provider). */
	defaultProvider: ConfigurableProvider | null;
	/** Admin-chosen per-task provider map (provider_settings.task_routing), validated. */
	taskRouting: Partial<Record<TaskKind, ConfigurableProvider>>;
	/** Stored org keys, decrypted (never leaves the process). */
	credentials: Partial<Record<ConfigurableProvider, Credential>>;
}

const TTL_MS = 30_000;

interface CacheEntry {
	at: number;
	value: OrgAiRouting;
	inflight: Promise<OrgAiRouting> | null;
}

const cache = new Map<string, CacheEntry>();
let warnedDecrypt = false;

function empty(orgId: string): OrgAiRouting {
	return { orgId, defaultProvider: null, taskRouting: {}, credentials: {} };
}

function isProvider(id: unknown): id is ConfigurableProvider {
	return typeof id === 'string' && id in PROVIDERS;
}

async function load(orgId: string): Promise<OrgAiRouting> {
	const db = getDb();
	const out = empty(orgId);
	if (!db) return out;

	const [settings] = await db.select().from(providerSettings).where(eq(providerSettings.orgId, orgId));
	if (settings) {
		if (isProvider(settings.defaultProvider)) out.defaultProvider = settings.defaultProvider;
		for (const [task, prov] of Object.entries(settings.taskRouting ?? {})) {
			if ((TASK_KINDS as readonly string[]).includes(task) && isProvider(prov)) {
				out.taskRouting[task as TaskKind] = prov;
			}
		}
	}

	const keys = await db.select().from(providerKeys).where(eq(providerKeys.orgId, orgId));
	for (const k of keys) {
		if (!isProvider(k.provider)) continue; // vendor keys (cohere/jina/llamaparse) are not chat credentials
		try {
			out.credentials[k.provider] = {
				provider: k.provider,
				apiKey: decryptSecret(k.apiKeyEnc),
				baseUrl: k.baseUrl ?? undefined,
				model: k.model ?? undefined
			};
		} catch (e) {
			if (!warnedDecrypt) {
				warnedDecrypt = true;
				console.error(
					`[ai/org-routing] cannot decrypt stored ${k.provider} key (is MASTER_ENCRYPTION_KEY set in this process, e.g. the worker?):`,
					e instanceof Error ? e.message : e
				);
			}
		}
	}
	return out;
}

function refresh(orgId: string): Promise<OrgAiRouting> {
	const existing = cache.get(orgId);
	if (existing?.inflight) return existing.inflight;
	const inflight = load(orgId)
		.then((value) => {
			cache.set(orgId, { at: Date.now(), value, inflight: null });
			return value;
		})
		.catch((e) => {
			// Transient DB blip: keep serving the previous value (or env-only empty).
			console.error('[ai/org-routing] refresh failed:', e instanceof Error ? e.message : e);
			const prev = cache.get(orgId)?.value ?? empty(orgId);
			cache.set(orgId, { at: Date.now(), value: prev, inflight: null });
			return prev;
		});
	cache.set(orgId, { at: existing?.at ?? 0, value: existing?.value ?? empty(orgId), inflight });
	return inflight;
}

/**
 * Synchronous cached view (may be null before the first load completes).
 * Triggers a background refresh when missing/stale — stale-while-revalidate.
 */
export function getOrgAiRoutingCached(orgId: string): OrgAiRouting | null {
	const hit = cache.get(orgId);
	if (!hit) {
		void refresh(orgId);
		return null;
	}
	if (Date.now() - hit.at > TTL_MS) void refresh(orgId);
	return hit.value;
}

/** Awaited view — fresh within the TTL. Never throws (degrades to env-only). */
export async function getOrgAiRouting(orgId: string): Promise<OrgAiRouting> {
	const hit = cache.get(orgId);
	if (hit && !hit.inflight && Date.now() - hit.at < TTL_MS) return hit.value;
	return refresh(orgId);
}

/** Call after any provider_settings / provider_keys write so edits apply promptly. */
export function invalidateOrgAiRouting(orgId?: string): void {
	if (orgId) cache.delete(orgId);
	else cache.clear();
}
