/**
 * Provider configuration + env access.
 *
 * getEnv() is the single env seam that works in BOTH the SvelteKit runtime and
 * the standalone pg-boss worker (process.env is populated in both under the
 * node adapter / tsx). Never import $env here.
 */
import type { ProviderId, TaskKind } from './types';

export const getEnv = (k: string): string | undefined => {
	const v = process.env[k];
	return v && String(v).length ? String(v) : undefined;
};

export interface ProviderMeta {
	id: Exclude<ProviderId, 'mock' | 'chatgpt-oauth'>;
	label: string;
	/** Env var holding the API key (BYO / server default). */
	keyEnv: string;
	/** Env var overriding the base URL (openai-compatible family). */
	baseUrlEnv?: string;
	defaultBaseUrl?: string;
	/** Env var overriding the default chat model. */
	modelEnv: string;
	defaultModel: string;
	embedModel?: string;
	supportsEmbeddings: boolean;
	/** True when the vendor speaks the OpenAI Chat Completions wire format. */
	openaiCompatible: boolean;
}

/**
 * The provider registry metadata. OpenAI, Moonshot/Kimi, DeepSeek, MiniMax and
 * the generic endpoint all speak the OpenAI wire format and share one adapter;
 * Gemini and Anthropic have native adapters.
 */
export const PROVIDERS: Record<ProviderMeta['id'], ProviderMeta> = {
	gemini: {
		id: 'gemini',
		label: 'Google Gemini',
		keyEnv: 'GEMINI_API_KEY',
		modelEnv: 'GEMINI_MODEL',
		defaultModel: 'gemini-2.5-flash',
		embedModel: 'gemini-embedding-001',
		supportsEmbeddings: true,
		openaiCompatible: false
	},
	anthropic: {
		id: 'anthropic',
		label: 'Anthropic Claude',
		keyEnv: 'ANTHROPIC_API_KEY',
		modelEnv: 'ANTHROPIC_MODEL',
		defaultModel: 'claude-sonnet-5',
		supportsEmbeddings: false,
		openaiCompatible: false
	},
	openai: {
		id: 'openai',
		label: 'OpenAI',
		keyEnv: 'OPENAI_API_KEY',
		modelEnv: 'OPENAI_MODEL',
		defaultBaseUrl: 'https://api.openai.com/v1',
		defaultModel: 'gpt-4o',
		embedModel: 'text-embedding-3-small',
		supportsEmbeddings: true,
		openaiCompatible: true
	},
	moonshot: {
		id: 'moonshot',
		label: 'Moonshot (Kimi K2)',
		keyEnv: 'MOONSHOT_API_KEY',
		modelEnv: 'MOONSHOT_MODEL',
		defaultBaseUrl: 'https://api.moonshot.ai/v1',
		defaultModel: 'kimi-k2-0711-preview',
		supportsEmbeddings: false,
		openaiCompatible: true
	},
	deepseek: {
		id: 'deepseek',
		label: 'DeepSeek',
		keyEnv: 'DEEPSEEK_API_KEY',
		modelEnv: 'DEEPSEEK_MODEL',
		defaultBaseUrl: 'https://api.deepseek.com/v1',
		defaultModel: 'deepseek-chat',
		supportsEmbeddings: false,
		openaiCompatible: true
	},
	minimax: {
		id: 'minimax',
		label: 'MiniMax',
		keyEnv: 'MINIMAX_API_KEY',
		modelEnv: 'MINIMAX_MODEL',
		defaultBaseUrl: 'https://api.minimaxi.chat/v1',
		defaultModel: 'MiniMax-Text-01',
		supportsEmbeddings: false,
		openaiCompatible: true
	},
	'openai-compatible': {
		id: 'openai-compatible',
		label: 'OpenAI-compatible (custom)',
		keyEnv: 'OPENAI_COMPAT_API_KEY',
		baseUrlEnv: 'OPENAI_COMPAT_BASE_URL',
		modelEnv: 'OPENAI_COMPAT_MODEL',
		defaultModel: '',
		supportsEmbeddings: false,
		openaiCompatible: true
	}
};

export type ConfigurableProvider = ProviderMeta['id'];

/** Ordered fallback list of providers to try for chat when the default has no key. */
export const CHAT_FALLBACK_ORDER: ConfigurableProvider[] = [
	'gemini',
	'anthropic',
	'openai',
	'deepseek',
	'moonshot',
	'minimax',
	'openai-compatible'
];

/** Which provider a given task defaults to, overridable via LLM_<TASK>_PROVIDER. */
export function defaultProviderForTask(task: TaskKind): ConfigurableProvider {
	const override = getEnv(`LLM_${task.toUpperCase()}_PROVIDER`) as ConfigurableProvider | undefined;
	if (override && override in PROVIDERS) return override;
	const global = getEnv('LLM_PROVIDER') as ConfigurableProvider | undefined;
	if (global && global in PROVIDERS) return global;
	return 'gemini';
}

/** True when at least one provider has a server-side key configured. */
export function anyProviderConfigured(): boolean {
	return (Object.values(PROVIDERS) as ProviderMeta[]).some((m) => !!getEnv(m.keyEnv));
}

/** The first provider (by fallback order) that has a key configured, or null. */
export function firstConfiguredProvider(): ConfigurableProvider | null {
	for (const id of CHAT_FALLBACK_ORDER) {
		if (getEnv(PROVIDERS[id].keyEnv)) return id;
	}
	return null;
}

export function modelFor(id: ConfigurableProvider): string {
	const m = PROVIDERS[id];
	return getEnv(m.modelEnv) ?? m.defaultModel;
}

export function baseUrlFor(id: ConfigurableProvider): string | undefined {
	const m = PROVIDERS[id];
	return (m.baseUrlEnv ? getEnv(m.baseUrlEnv) : undefined) ?? m.defaultBaseUrl;
}
