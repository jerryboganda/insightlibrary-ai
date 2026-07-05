/**
 * Credential store + resolver for the multi-provider LLM layer.
 *
 * Precedence (per the plan's ownership table):
 *   per-request forwarded OAuth token (never persisted — handled at call site)
 *   > per-user BYO key (user_ai_credentials, web) / OS keyring (desktop)
 *   > per-org key (provider_keys)
 *   > server env key (handled by the router).
 *
 * Keys are stored AES-256-GCM encrypted (MASTER_ENCRYPTION_KEY). This module is
 * only used from SvelteKit routes (interactive); the worker relies on env keys.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { providerKeys, providerSettings, userAiCredentials } from '../db/schema';
import type { AiKeyInput, ProviderId as WireProviderId } from '@insightlibrary/schemas';
import {
	PROVIDERS,
	decryptSecret,
	encryptSecret,
	keyHint,
	firstConfiguredProvider,
	type Credential,
	type ConfigurableProvider
} from './providers';

export interface Scope {
	orgId?: string;
	userId?: string;
}

const envKeyPresent = (p: ConfigurableProvider): boolean => !!process.env[PROVIDERS[p].keyEnv];

/** Resolve a stored credential for a specific provider (user scope then org). */
export async function resolveStoredCredential(scope: Scope, provider: ConfigurableProvider): Promise<Credential | null> {
	const db = getDb();
	if (!db) return null;
	if (scope.userId) {
		const [u] = await db
			.select()
			.from(userAiCredentials)
			.where(and(eq(userAiCredentials.userId, scope.userId), eq(userAiCredentials.provider, provider)));
		if (u) return { provider, apiKey: decryptSecret(u.apiKeyEnc), baseUrl: u.baseUrl ?? undefined, model: u.model ?? undefined };
	}
	if (scope.orgId) {
		const [o] = await db
			.select()
			.from(providerKeys)
			.where(and(eq(providerKeys.orgId, scope.orgId), eq(providerKeys.provider, provider)));
		if (o) return { provider, apiKey: decryptSecret(o.apiKeyEnc), baseUrl: o.baseUrl ?? undefined, model: o.model ?? undefined };
	}
	return null;
}

/**
 * Best credential to inject into router ctx for a chat request: the first stored
 * key across providers, else null (router then falls back to env, then mock).
 */
export async function resolveChatCredential(scope: Scope): Promise<Credential | null> {
	const db = getDb();
	if (!db) return null;
	let order = Object.keys(PROVIDERS) as ConfigurableProvider[];
	// Honor the org's configured default provider (provider_settings) first.
	if (scope.orgId) {
		const [settings] = await db.select().from(providerSettings).where(eq(providerSettings.orgId, scope.orgId));
		const def = settings?.defaultProvider as ConfigurableProvider | undefined;
		if (def && def in PROVIDERS) order = [def, ...order.filter((p) => p !== def)];
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
	}
}

export interface ProviderStatus {
	id: ConfigurableProvider;
	label: string;
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
	return (Object.keys(PROVIDERS) as ConfigurableProvider[]).map((id) => {
		const meta = PROVIDERS[id];
		const stored = userRows.find((r) => r.provider === id) ?? orgRows.find((r) => r.provider === id);
		return {
			id,
			label: meta.label,
			envConfigured: envKeyPresent(id),
			keyStored: !!stored,
			hint: stored?.hint ?? '',
			model: stored?.model ?? null,
			supportsEmbeddings: meta.supportsEmbeddings
		};
	});
}

export { firstConfiguredProvider };
