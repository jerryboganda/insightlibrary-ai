/**
 * Anthropic Claude adapter (native @anthropic-ai/sdk). No embeddings API →
 * embed() is intentionally absent (the router keeps embeddings on Gemini).
 * Structured output is done via prompt-instructed JSON + loose parsing.
 */
import type { ChatMessage, ChatOptions, Credential, JsonOptions, LlmProvider } from './types';
import { parseJsonLoose, schemaInstruction, splitSystem } from './util';

type AnthropicMsg = { role: 'user' | 'assistant'; content: string };

export class AnthropicProvider implements LlmProvider {
	readonly id = 'anthropic' as const;
	constructor(private cred: Credential) {}

	private async client() {
		const mod = await import('@anthropic-ai/sdk');
		const Anthropic = mod.default;
		return new Anthropic({ apiKey: this.cred.apiKey });
	}

	private model(opts?: ChatOptions) {
		return opts?.model ?? this.cred.model ?? 'claude-sonnet-5';
	}

	async *chatStream(messages: ChatMessage[], opts?: ChatOptions): AsyncGenerator<string, void, unknown> {
		const client = await this.client();
		const { system, turns } = splitSystem(messages, opts?.system);
		const stream = await client.messages.create({
			model: this.model(opts),
			max_tokens: opts?.maxTokens ?? 4096,
			temperature: opts?.temperature,
			system: system || undefined,
			messages: turns as AnthropicMsg[],
			stream: true
		});
		for await (const event of stream) {
			if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
				yield event.delta.text;
			}
		}
	}

	async complete(messages: ChatMessage[], opts?: ChatOptions): Promise<string> {
		const client = await this.client();
		const { system, turns } = splitSystem(messages, opts?.system);
		const res = await client.messages.create({
			model: this.model(opts),
			max_tokens: opts?.maxTokens ?? 4096,
			temperature: opts?.temperature,
			system: system || undefined,
			messages: turns as AnthropicMsg[]
		});
		return res.content
			.map((b) => (b.type === 'text' ? b.text : ''))
			.join('')
			.trim();
	}

	async json<T = unknown>(messages: ChatMessage[], opts?: JsonOptions): Promise<T> {
		const text = await this.complete(messages, {
			...opts,
			system: [opts?.system, schemaInstruction(opts?.schema)].filter(Boolean).join('\n\n'),
			temperature: opts?.temperature ?? 0
		});
		return parseJsonLoose<T>(text);
	}
}
