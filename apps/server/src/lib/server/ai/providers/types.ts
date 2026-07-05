/**
 * Multi-provider LLM abstraction — canonical types.
 *
 * This layer is the SOLE owner of provider access (per the plan's Phase-0
 * ownership table). Every other subsystem (copilot, claim extraction,
 * correlation NLI, synthesis, rerank, eval judge) imports `getRouter()` from
 * ./router and never talks to a vendor SDK directly.
 *
 * Design constraints:
 *  - Works in BOTH the SvelteKit runtime and the standalone pg-boss worker →
 *    everything reads process.env via config.getEnv(), never $env.
 *  - Degrades to a deterministic mock when no key is configured, matching the
 *    app's existing "runs with zero external services" behavior.
 *  - Embeddings for the pgvector store stay 768-dim Gemini (see ai/embeddings.ts);
 *    provider.embed() here is only for providers that expose embeddings.
 */

export type ProviderId =
	| 'gemini'
	| 'anthropic'
	| 'openai'
	| 'moonshot'
	| 'deepseek'
	| 'minimax'
	| 'openai-compatible'
	| 'chatgpt-oauth'
	| 'mock';

/** Logical task → lets the router pick a provider/model per workload. */
export type TaskKind =
	| 'chat' // interactive copilot
	| 'extraction' // atomic claim / triple extraction (cheap, structured)
	| 'synthesis' // topic-page composition (strong)
	| 'nli' // equivalence / contradiction judgments (cheap, structured)
	| 'rerank' // LLM-based reranking
	| 'embedding';

/** All routable tasks — used to validate org task_routing and build UIs. */
export const TASK_KINDS: readonly TaskKind[] = ['chat', 'extraction', 'synthesis', 'nli', 'rerank', 'embedding'];

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface ChatOptions {
	model?: string;
	system?: string;
	temperature?: number;
	maxTokens?: number;
	signal?: AbortSignal;
}

export interface JsonOptions extends ChatOptions {
	/** A JSON-Schema-ish object for providers with native structured output. */
	schema?: Record<string, unknown>;
	schemaName?: string;
}

/** A resolved credential for one provider call (env / per-org / per-user / OAuth). */
export interface Credential {
	provider: ProviderId;
	apiKey?: string;
	baseUrl?: string;
	oauthToken?: string;
	model?: string;
}

export interface LlmProvider {
	readonly id: ProviderId;
	/** Stream assistant text tokens. */
	chatStream(messages: ChatMessage[], opts?: ChatOptions): AsyncGenerator<string, void, unknown>;
	/** Non-streaming completion → full assistant text. */
	complete(messages: ChatMessage[], opts?: ChatOptions): Promise<string>;
	/** Structured output → parsed JSON of shape T (caller validates with zod). */
	json<T = unknown>(messages: ChatMessage[], opts?: JsonOptions): Promise<T>;
	/** Optional embeddings (only some providers). */
	embed?(input: string | string[], opts?: { model?: string; dimensions?: number }): Promise<number[][] | null>;
}

/** Thrown when a task has no usable credential AND the caller opted out of mock. */
export class NoCredentialError extends Error {
	constructor(msg = 'no LLM credential configured') {
		super(msg);
		this.name = 'NoCredentialError';
	}
}

/** Thrown when a provider cannot perform a capability (e.g. Anthropic embeddings). */
export class UnsupportedError extends Error {
	constructor(msg = 'unsupported provider capability') {
		super(msg);
		this.name = 'UnsupportedError';
	}
}

/**
 * Thrown by the router (and embedText) when the org's monthly hard budget limit
 * (org_settings.budgetMonthlyLimitUsd) has been reached — the AI call is refused
 * before any tokens are spent. Callers may surface `limitUsd`/`spendUsd`.
 */
export class BudgetExceededError extends Error {
	constructor(
		public readonly limitUsd: number,
		public readonly spendUsd: number,
		msg?: string
	) {
		super(
			msg ??
				`AI budget exceeded: $${spendUsd.toFixed(2)} spent of the $${limitUsd.toFixed(2)} monthly hard limit — call refused`
		);
		this.name = 'BudgetExceededError';
	}
}
