/**
 * The task router — the ONE entry point every subsystem uses for LLM work.
 *
 * Resolution order per call (gaps A8/C5):
 *   1. explicit per-request credential (ctx.credential — stored user key or
 *      forwarded OAuth token, resolved at the route)
 *   2. ctx.provider force-pick (stored org key for it, else env key)
 *   3. org provider_settings.task_routing[task]   ─┐ stored org keys win over
 *   4. org provider_settings.default_provider     ─┤ env keys per provider
 *   5. env LLM_<TASK>_PROVIDER / LLM_PROVIDER / gemini
 *   6. remaining providers in CHAT_FALLBACK_ORDER
 * Falls back to the deterministic mock when nothing is configured (unchanged).
 *
 * Cross-cutting (gaps C6/B17): before each paid call the router enforces the
 * org's monthly budget (BudgetExceededError on the hard limit, audit warning at
 * the soft threshold) and meters every real call to usage_events.
 *
 * Org-stored keys/routing come from the org-routing cache (30s TTL,
 * stale-while-revalidate) so this works identically in the SvelteKit runtime
 * and the pg-boss worker; the synchronous `available()`/`activeProvider()`
 * gates used by refinery modules read the cached view (env-only until the
 * first refresh lands moments after process start).
 */
import type {
	ChatMessage,
	ChatOptions,
	Credential,
	JsonOptions,
	LlmProvider,
	ProviderId,
	TaskKind
} from './types';
import { TASK_KINDS } from './types';
import {
	CHAT_FALLBACK_ORDER,
	PROVIDERS,
	baseUrlFor,
	defaultProviderForTask,
	getEnv,
	modelFor,
	type ConfigurableProvider
} from './config';
import { buildProvider } from './registry';
import { MockProvider } from './mock';
import { getOrgAiRouting, getOrgAiRoutingCached, type OrgAiRouting } from './org-routing';
import { enforceBudget, recordAiUsage } from '../../usage/metering';

export interface RouteContext {
	/** Explicit per-request credential (resolved from DB or a forwarded OAuth token). */
	credential?: Credential;
	/** Force a specific provider regardless of task defaults. */
	provider?: ConfigurableProvider;
	model?: string;
	/** Org whose stored keys / routing / budget apply (defaults to the router's org). */
	orgId?: string;
	/** Attribute metered usage to this user. */
	userId?: string;
}

export interface CallOptions extends ChatOptions {
	task?: TaskKind;
	ctx?: RouteContext;
}
export interface JsonCallOptions extends JsonOptions {
	task?: TaskKind;
	ctx?: RouteContext;
}

function envCredential(id: ConfigurableProvider): Credential | null {
	const meta = PROVIDERS[id];
	const apiKey = getEnv(meta.keyEnv);
	if (!apiKey) return null;
	return { provider: id, apiKey, baseUrl: baseUrlFor(id), model: modelFor(id) };
}

/** Provider preference order: org task routing > org default > env > fallbacks. */
function preferenceOrder(task: TaskKind, routing: OrgAiRouting | null): ConfigurableProvider[] {
	const order: ConfigurableProvider[] = [];
	const push = (p: string | null | undefined) => {
		if (p && p in PROVIDERS && !order.includes(p as ConfigurableProvider)) order.push(p as ConfigurableProvider);
	};
	push(routing?.taskRouting[task]);
	push(routing?.defaultProvider);
	push(defaultProviderForTask(task));
	for (const p of CHAT_FALLBACK_ORDER) push(p);
	return order;
}

function resolveWith(task: TaskKind, ctx: RouteContext | undefined, routing: OrgAiRouting | null): Credential | null {
	if (ctx?.credential && (ctx.credential.apiKey || ctx.credential.oauthToken)) return ctx.credential;
	const stored = routing?.credentials ?? {};
	if (ctx?.provider) {
		const c = stored[ctx.provider] ?? envCredential(ctx.provider);
		if (c) return ctx.model ? { ...c, model: ctx.model } : c;
	}
	for (const id of preferenceOrder(task, routing)) {
		const c = stored[id] ?? envCredential(id);
		if (c) return c;
	}
	return null;
}

function resolveEmbeddingWith(ctx: RouteContext | undefined, routing: OrgAiRouting | null): Credential | null {
	if (ctx?.credential && (ctx.credential.apiKey || ctx.credential.oauthToken)) return ctx.credential;
	const stored = routing?.credentials ?? {};
	for (const id of ['gemini', 'openai'] as ConfigurableProvider[]) {
		if (!PROVIDERS[id].supportsEmbeddings) continue;
		const c = stored[id] ?? envCredential(id);
		if (c) return c;
	}
	return null;
}

function approxChars(messages: ChatMessage[], system?: string): number {
	return messages.reduce((s, m) => s + m.content.length, 0) + (system?.length ?? 0);
}

function meteredModel(cred: Credential): string {
	if (cred.model) return cred.model;
	return cred.provider in PROVIDERS ? modelFor(cred.provider as ConfigurableProvider) : '';
}

class Router {
	constructor(private readonly orgId: string) {}

	private orgFor(ctx?: RouteContext): string {
		return ctx?.orgId || this.orgId;
	}

	private async resolveAsync(task: TaskKind, ctx?: RouteContext): Promise<Credential | null> {
		return resolveWith(task, ctx, await getOrgAiRouting(this.orgFor(ctx)));
	}

	/**
	 * Resolve + budget-gate + build the provider for one imminent call.
	 * Budget applies only to org-billed credentials (a forwarded OAuth token
	 * rides the user's own subscription; the mock costs nothing).
	 */
	private async prepare(
		task: TaskKind,
		ctx?: RouteContext
	): Promise<{ provider: LlmProvider; cred: Credential | null }> {
		const cred = await this.resolveAsync(task, ctx);
		if (cred?.apiKey) await enforceBudget(this.orgFor(ctx), task);
		return { provider: cred ? buildProvider(cred) : new MockProvider(), cred };
	}

	private meter(
		task: TaskKind,
		ctx: RouteContext | undefined,
		cred: Credential,
		charsIn: number,
		charsOut: number,
		startedAt: number
	): void {
		recordAiUsage({
			orgId: this.orgFor(ctx),
			userId: ctx?.userId,
			provider: cred.provider,
			model: meteredModel(cred),
			task,
			charsIn,
			charsOut,
			// A forwarded ChatGPT-subscription token costs the org nothing.
			costUsd: cred.oauthToken && !cred.apiKey ? 0 : undefined,
			durationMs: Date.now() - startedAt
		});
	}

	/**
	 * Is a real (non-mock) provider available for this task? Synchronous — uses
	 * env keys plus the cached org routing (stale-while-revalidate).
	 */
	available(task: TaskKind = 'chat', ctx?: RouteContext): boolean {
		return resolveWith(task, ctx, getOrgAiRoutingCached(this.orgFor(ctx))) !== null;
	}

	/** The provider id that would serve this task (sync, cached-org view). */
	activeProvider(task: TaskKind = 'chat', ctx?: RouteContext): ProviderId {
		return resolveWith(task, ctx, getOrgAiRoutingCached(this.orgFor(ctx)))?.provider ?? 'mock';
	}

	/** Awaited variant of available() — consults fresh org routing. */
	async availableAsync(task: TaskKind = 'chat', ctx?: RouteContext): Promise<boolean> {
		return (await this.resolveAsync(task, ctx)) !== null;
	}

	/** Awaited variant of activeProvider() — consults fresh org routing. */
	async activeProviderAsync(task: TaskKind = 'chat', ctx?: RouteContext): Promise<ProviderId> {
		return (await this.resolveAsync(task, ctx))?.provider ?? 'mock';
	}

	/** Effective provider per task after org routing + env fallbacks (settings UI). */
	async taskProviders(ctx?: RouteContext): Promise<Record<TaskKind, ProviderId>> {
		const routing = await getOrgAiRouting(this.orgFor(ctx));
		const out = {} as Record<TaskKind, ProviderId>;
		for (const task of TASK_KINDS) {
			out[task] = resolveWith(task, ctx, routing)?.provider ?? 'mock';
		}
		return out;
	}

	async *chatStream(messages: ChatMessage[], opts: CallOptions = {}): AsyncGenerator<string, void, unknown> {
		const { task = 'chat', ctx, ...rest } = opts;
		const { provider, cred } = await this.prepare(task, ctx);
		const startedAt = Date.now();
		let charsOut = 0;
		try {
			for await (const token of provider.chatStream(messages, rest)) {
				charsOut += token.length;
				yield token;
			}
		} finally {
			if (cred) this.meter(task, ctx, cred, approxChars(messages, rest.system), charsOut, startedAt);
		}
	}

	async complete(messages: ChatMessage[], opts: CallOptions = {}): Promise<string> {
		const { task = 'chat', ctx, ...rest } = opts;
		const { provider, cred } = await this.prepare(task, ctx);
		const startedAt = Date.now();
		const out = await provider.complete(messages, rest);
		if (cred) this.meter(task, ctx, cred, approxChars(messages, rest.system), out.length, startedAt);
		return out;
	}

	async json<T = unknown>(messages: ChatMessage[], opts: JsonCallOptions = {}): Promise<T> {
		const { task = 'extraction', ctx, ...rest } = opts;
		const { provider, cred } = await this.prepare(task, ctx);
		const startedAt = Date.now();
		const out = await provider.json<T>(messages, rest);
		if (cred) {
			let charsOut = 0;
			try {
				charsOut = JSON.stringify(out)?.length ?? 0;
			} catch {
				charsOut = 0;
			}
			this.meter(task, ctx, cred, approxChars(messages, rest.system), charsOut, startedAt);
		}
		return out;
	}

	async embed(
		input: string | string[],
		opts: { ctx?: RouteContext; model?: string; dimensions?: number } = {}
	): Promise<number[][] | null> {
		const routing = await getOrgAiRouting(this.orgFor(opts.ctx));
		const cred = resolveEmbeddingWith(opts.ctx, routing);
		if (!cred) return null;
		if (cred.apiKey) await enforceBudget(this.orgFor(opts.ctx), 'embedding');
		const provider = buildProvider(cred);
		if (!provider.embed) return null;
		const startedAt = Date.now();
		const res = await provider.embed(input, { model: opts.model, dimensions: opts.dimensions });
		if (res) {
			const charsIn = Array.isArray(input) ? input.reduce((s, t) => s + t.length, 0) : input.length;
			this.meter('embedding', opts.ctx, cred, charsIn, 0, startedAt);
		}
		return res;
	}
}

const routers = new Map<string, Router>();

/**
 * Per-org router. Bare getRouter() binds the default org — matching the
 * platform-wide org_1 fallback — so admin-stored BYO keys power refinery,
 * ingestion, and generation call sites that don't (yet) thread an orgId.
 */
export function getRouter(orgId = 'org_1'): Router {
	let r = routers.get(orgId);
	if (!r) {
		r = new Router(orgId);
		routers.set(orgId, r);
	}
	// Kick a stale-while-revalidate refresh so sync gates converge quickly.
	getOrgAiRoutingCached(orgId);
	return r;
}
export type { Router };
