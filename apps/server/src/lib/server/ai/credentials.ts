/**
 * Credential store + resolver for the multi-provider LLM layer.
 *
 * Precedence (per the plan's ownership table):
 *   per-request forwarded OAuth token (never persisted — handled at call site)
 *   > per-user BYO key (user_ai_credentials, web) / OS keyring (desktop)
 *   > per-org key (provider_keys)
 *   > server env key (handled by the router).
 *
 * Keys are stored AES-256-GCM encrypted (MASTER_ENCRYPTION_KEY). Besides the
 * chat providers, the same store now holds non-LLM vendor keys (cohere / jina
 * rerank, llamaparse external parsing) — resolved via resolveVendorKey().
 *
 * Org-level routing + stored keys for the ROUTER's own resolution live in
 * ./providers/org-routing (cached); this module remains the seam for
 * user-scoped keys, key CRUD, and the settings UI status list.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { providerKeys, userAiCredentials } from '../db/schema';
import type { AiKeyInput, ProviderId as WireProviderId } from '@insightlibrary/schemas';
import {
	PROVIDERS,
	VENDOR_KEYS,
	isVendorId,
	getEnv,
	decryptSecret,
	encryptSecret,
	keyHint,
	firstConfiguredProvider,
	getOrgAiRouting,
	invalidateOrgAiRouting,
	type Credential,
	type ConfigurableProvider,
	type VendorId
} from './providers';

export interface Scope {
	orgId?: string;
	userId?: string;
}

/** Everything storable in the encrypted key store: chat providers + vendors. */
export type StorableProvider = ConfigurableProvider | VendorId;

const envKeyPresent = (p: StorableProvider): boolean =>
	!!(isVendorId(p) ? getEnv(VENDOR_KEYS[p].keyEnv) : getEnv(PROVIDERS[p].keyEnv));

/** Resolve a stored credential for a specific provider (user scope then org). */
export async function resolveStoredCredential(scope: Scope, provider: StorableProvider): Promise<Credential | null> {
	const db = getDb();
	if (!db) return null;
	if (scope.userId) {
		const [u] = await db
			.select()
			.from(userAiCredentials)
			.where(and(eq(userAiCredentials.userId, scope.userId), eq(userAiCredentials.provider, provider)));
		if (u)
			return {
				provider: provider as Credential['provider'],
				apiKey: decryptSecret(u.apiKeyEnc),
				baseUrl: u.baseUrl ?? undefined,
				model: u.model ?? undefined
			};
	}
	if (scope.orgId) {
		const [o] = await db
			.select()
			.from(providerKeys)
			.where(and(eq(providerKeys.orgId, scope.orgId), eq(providerKeys.provider, provider)));
		if (o)
			return {
				provider: provider as Credential['provider'],
				apiKey: decryptSecret(o.apiKeyEnc),
				baseUrl: o.baseUrl ?? undefined,
				model: o.model ?? undefined
			};
	}
	return null;
}

/**
 * Vendor-service API key (cohere / jina / llamaparse): stored org key first,
 * env var fallback. Consumed by rerank + external-parse call sites.
 */
export async function resolveVendorKey(orgId: string, vendor: VendorId): Promise<string | null> {
	try {
		const stored = await resolveStoredCredential({ orgId }, vendor);
		if (stored?.apiKey) return stored.apiKey;
	} catch (e) {
		console.error(`[ai/credentials] failed to read stored ${vendor} key:`, e instanceof Error ? e.message : e);
	}
	return getEnv(VENDOR_KEYS[vendor].keyEnv) ?? null;
}

/** The org's routing preferences (provider_settings), cached. For GET /api/ai/providers. */
export async function getOrgProviderSettings(
	orgId: string
): Promise<{ defaultProvider: string | null; taskRouting: Record<string, string> }> {
	const routing = await getOrgAiRouting(orgId);
	return { defaultProvider: routing.defaultProvider, taskRouting: { ...routing.taskRouting } };
}

/**
 * Best credential to inject into router ctx for a chat request: the first stored
 * key across providers, else null (router then falls back to env, then mock).
 * Honors the org's task routing for 'chat' and its default provider first.
 */
export async function resolveChatCredential(scope: Scope): Promise<Credential | null> {
	const db = getDb();
	if (!db) return null;
	let order = Object.keys(PROVIDERS) as ConfigurableProvider[];
	if (scope.orgId) {
		const routing = await getOrgAiRouting(scope.orgId);
		const prefs = [routing.taskRouting.chat, routing.defaultProvider].filter(
			(p): p is ConfigurableProvider => !!p && p in PROVIDERS
		);
		order = [...prefs, ...order.filter((p) => !prefs.includes(p))];
	}
	for (const p of order) {
		const c = await resolveStoredCredential(scope, p);
		if (c) return c;
	}
	return null;
}

/** Store/overwrite a key (encrypted). Scope selects org-shared vs user-personal. */
export async function storeKey(input: AiKeyInput, scope: Scope): Promise<void> {
	const db = getDb();
	if (!db) throw new Error('A database is required to store API keys');
	const apiKeyEnc = encryptSecret(input.apiKey);
	const hint = keyHint(input.apiKey);
	const baseUrl = input.baseUrl ?? null;
	const model = input.model ?? null;

	if (input.scope === 'user') {
		if (!scope.userId) throw new Error('user scope requires an authenticated user');
		await db
			.insert(userAiCredentials)
			.values({ id: `uac_${scope.userId}_${input.provider}`, userId: scope.userId, provider: input.provider, apiKeyEnc, baseUrl, model, hint })
			.onConflictDoUpdate({
				target: [userAiCredentials.userId, userAiCredentials.provider],
				set: { apiKeyEnc, baseUrl, model, hint, updatedAt: new Date() }
			});
	} else {
		if (!scope.orgId) throw new Error('org scope requires an org');
		await db
			.insert(providerKeys)
			.values({ id: `pk_${scope.orgId}_${input.provider}`, orgId: scope.orgId, provider: input.provider, apiKeyEnc, baseUrl, model, hint })
			.onConflictDoUpdate({
				target: [providerKeys.orgId, providerKeys.provider],
				set: { apiKeyEnc, baseUrl, model, hint, updatedAt: new Date() }
			});
		// Org keys feed the router's cached routing — apply the edit promptly.
		invalidateOrgAiRouting(scope.orgId);
	}
}

export async function deleteKey(provider: WireProviderId, scope: Scope & { scope: 'org' | 'user' }): Promise<void> {
	const db = getDb();
	if (!db) return;
	if (scope.scope === 'user' && scope.userId) {
		await db
			.delete(userAiCredentials)
			.where(and(eq(userAiCredentials.userId, scope.userId), eq(userAiCredentials.provider, provider)));
	} else if (scope.orgId) {
		await db.delete(providerKeys).where(and(eq(providerKeys.orgId, scope.orgId), eq(providerKeys.provider, provider)));
		invalidateOrgAiRouting(scope.orgId);
	}
}

export interface ProviderStatus {
	id: StorableProvider;
	label: string;
	/** 'chat' = routable LLM provider; 'vendor' = service key (rerank/parse). */
	kind: 'chat' | 'vendor';
	envConfigured: boolean;
	keyStored: boolean;
	hint: string;
	model: string | null;
	supportsEmbeddings: boolean;
}

/** Status of every provider for the settings UI (never returns key material). */
export async function listProviderStatus(scope: Scope): Promise<ProviderStatus[]> {
	const db = getDb();
	const orgRows = db && scope.orgId ? await db.select().from(providerKeys).where(eq(providerKeys.orgId, scope.orgId)) : [];
	const userRows = db && scope.userId ? await db.select().from(userAiCredentials).where(eq(userAiCredentials.userId, scope.userId)) : [];
	const statusFor = (id: StorableProvider, label: string, kind: 'chat' | 'vendor', supportsEmbeddings: boolean): ProviderStatus => {
		const stored = userRows.find((r) => r.provider === id) ?? orgRows.find((r) => r.provider === id);
		return {
			id,
			label,
			kind,
			envConfigured: envKeyPresent(id),
			keyStored: !!stored,
			hint: stored?.hint ?? '',
			model: stored?.model ?? null,
			supportsEmbeddings
		};
	};
	return [
		...(Object.keys(PROVIDERS) as ConfigurableProvider[]).map((id) =>
			statusFor(id, PROVIDERS[id].label, 'chat', PROVIDERS[id].supportsEmbeddings)
		),
		...(Object.keys(VENDOR_KEYS) as VendorId[]).map((id) => statusFor(id, VENDOR_KEYS[id].label, 'vendor', false))
	];
}

export { firstConfiguredProvider };
