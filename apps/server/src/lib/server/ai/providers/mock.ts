/**
 * Deterministic mock provider — used when no API key is configured so the app
 * runs end-to-end with zero external services (matching the original behavior).
 * Structured output (json) is NOT mocked: refinery stages must guard with
 * anyProviderConfigured() and skip AI work when unconfigured.
 */
import type { ChatMessage, ChatOptions, JsonOptions, LlmProvider } from './types';
import { NoCredentialError } from './types';

export class MockProvider implements LlmProvider {
	readonly id = 'mock' as const;

	async *chatStream(messages: ChatMessage[], _opts?: ChatOptions): AsyncGenerator<string, void, unknown> {
		const last = [...messages].reverse().find((m) => m.role === 'user');
		const sentences = [
			'[mock] ',
			`I searched the SSOT and knowledge graph for "${last?.content ?? ''}". `,
			'In a configured deployment this streams live from your selected provider (the API key never reaches the client). ',
			'This is a local mock so the app works with zero external services.'
		];
		for (const s of sentences) {
			for (const word of s.split(/(\s+)/)) {
				yield word;
				await new Promise((r) => setTimeout(r, 8));
			}
		}
	}

	async complete(messages: ChatMessage[], _opts?: ChatOptions): Promise<string> {
		let out = '';
		for await (const t of this.chatStream(messages)) out += t;
		return out;
	}

	async json<T = unknown>(_messages: ChatMessage[], _opts?: JsonOptions): Promise<T> {
		throw new NoCredentialError('structured output requires a configured LLM provider');
	}
}
