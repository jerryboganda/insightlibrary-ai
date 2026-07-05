/**
 * The task router — the ONE entry point every subsystem uses for LLM work.
 * Resolves a credential (per-request > env), picks the provider for the task,
 * and falls back to the deterministic mock when nothing is configured.
 */
import type { ChatMessage, ChatOptions, Credential, JsonOptions, LlmProvider, ProviderId, TaskKind } from './types';
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

export interface RouteContext {
	/** Explicit per-request credential (resolved from DB or a forwarded OAuth token). */
	credential?: Credential;
	/** Force a specific provider regardless of task defaults. */
	provider?: ConfigurableProvider;
	model?: string;
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

function resolve(task: TaskKind, ctx?: RouteContext): Credential | null {
	if (ctx?.credential && (ctx.credential.apiKey || ctx.credential.oauthToken)) return ctx.credential;
	if (ctx?.provider) {
		const c = envCredential(ctx.provider);
		if (c) return ctx.model ? { ...c, model: ctx.model } : c;
	}
	const preferred = defaultProviderForTask(task);
	const order: ConfigurableProvider[] = [preferred, ...CHAT_FALLBACK_ORDER.filter((p) => p !== preferred)];
	for (const id of order) {
		const c = envCredential(id);
		if (c) return c;
	}
	return null;
}

function embeddingCredential(ctx?: RouteContext): Credential | null {
	if (ctx?.credential && (ctx.credential.apiKey || ctx.credential.oauthToken)) return ctx.credential;
	for (const id of ['gemini', 'openai'] as ConfigurableProvider[]) {
		if (PROVIDERS[id].supportsEmbeddings) {
			const c = envCredential(id);
			if (c) return c;
		}
	}
	return null;
}

class Router {
	private providerFor(task: TaskKind, ctx?: RouteContext): LlmProvider {
		const cred = resolve(task, ctx);
		return cred ? buildProvider(cred) : new MockProvider();
	}

	/** Is a real (non-mock) provider available for this task? */
	available(task: TaskKind = 'chat', ctx?: RouteContext): boolean {
		return resolve(task, ctx) !== null;
	}

	/** The provider id that would actually serve this task. */
	activeProvider(task: TaskKind = 'chat', ctx?: RouteContext): ProviderId {
		return resolve(task, ctx)?.provider ?? 'mock';
	}

	chatStream(messages: ChatMessage[], opts: CallOptions = {}): AsyncGenerator<string, void, unknown> {
		const { task = 'chat', ctx, ...rest } = opts;
		return this.providerFor(task, ctx).chatStream(messages, rest);
	}

	complete(messages: ChatMessage[], opts: CallOptions = {}): Promise<string> {
		const { task = 'chat', ctx, ...rest } = opts;
		return this.providerFor(task, ctx).complete(messages, rest);
	}

	json<T = unknown>(messages: ChatMessage[], opts: JsonCallOptions = {}): Promise<T> {
		const { task = 'extraction', ctx, ...rest } = opts;
		return this.providerFor(task, ctx).json<T>(messages, rest);
	}

	async embed(
		input: string | string[],
		opts: { ctx?: RouteContext; model?: string; dimensions?: number } = {}
	): Promise<number[][] | null> {
		const cred = embeddingCredential(opts.ctx);
		if (!cred) return null;
		const provider = buildProvider(cred);
		if (!provider.embed) return null;
		return provider.embed(input, { model: opts.model, dimensions: opts.dimensions });
	}
}

let _router: Router | null = null;
export function getRouter(): Router {
	return (_router ??= new Router());
}
export type { Router };
