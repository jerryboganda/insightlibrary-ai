import type { Credential, LlmProvider } from './types';
import { PROVIDERS } from './config';
import { GeminiProvider } from './gemini';
import { AnthropicProvider } from './anthropic';
import { OpenAiCompatibleProvider } from './openai-compatible';
import { ChatGptCodexProvider } from './chatgpt-codex';
import { MockProvider } from './mock';

/** Instantiate the concrete adapter for a resolved credential. */
export function buildProvider(cred: Credential): LlmProvider {
	switch (cred.provider) {
		case 'gemini':
			return new GeminiProvider(cred);
		case 'anthropic':
			return new AnthropicProvider(cred);
		case 'mock':
			return new MockProvider();
		case 'openai':
		case 'moonshot':
		case 'deepseek':
		case 'minimax':
		case 'openai-compatible': {
			const meta = PROVIDERS[cred.provider];
			return new OpenAiCompatibleProvider(cred.provider, cred, meta.supportsEmbeddings, meta.embedModel);
		}
		case 'chatgpt-oauth':
			// Consumer ChatGPT subscription via OAuth → Codex Responses API.
			return new ChatGptCodexProvider(cred);
		default:
			return new MockProvider();
	}
}
