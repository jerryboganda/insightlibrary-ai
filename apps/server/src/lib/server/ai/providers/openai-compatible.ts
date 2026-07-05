/**
 * OpenAI-wire-format adapter — powers OpenAI, Moonshot/Kimi, DeepSeek, MiniMax,
 * and any generic OpenAI-compatible endpoint. They differ only by baseURL, key
 * and model, so one adapter covers all five via the `openai` SDK.
 */
import type { ChatMessage, ChatOptions, Credential, JsonOptions, LlmProvider, ProviderId } from './types';
import { parseJsonLoose, schemaInstruction } from './util';

export class OpenAiCompatibleProvider implements LlmProvider {
	constructor(
		readonly id: ProviderId,
		private cred: Credential,
		private supportsEmbeddings = false,
		private embedModel = 'text-embedding-3-small'
	) {}

	private async client() {
		const mod = await import('openai');
		const OpenAI = mod.default;
		return new OpenAI({ apiKey: this.cred.apiKey ?? this.cred.oauthToken, baseURL: this.cred.baseUrl });
	}

	private model(opts?: ChatOptions) {
		const m = opts?.model ?? this.cred.model;
		if (!m) throw new Error(`no model configured for provider ${this.id}`);
		return m;
	}

	private toMessages(messages: ChatMessage[], system?: string) {
		const out = messages.map((m) => ({ role: m.role, content: m.content }));
		if (system) out.unshift({ role: 'system', content: system });
		return out as { role: 'system' | 'user' | 'assistant'; content: string }[];
	}

	async *chatStream(messages: ChatMessage[], opts?: ChatOptions): AsyncGenerator<string, void, unknown> {
		const client = await this.client();
		const stream = await client.chat.completions.create({
			model: this.model(opts),
			messages: this.toMessages(messages, opts?.system),
			temperature: opts?.temperature,
			max_tokens: opts?.maxTokens,
			stream: true
		});
		for await (const part of stream) {
			const delta = part.choices?.[0]?.delta?.content;
			if (delta) yield delta;
		}
	}

	async complete(messages: ChatMessage[], opts?: ChatOptions): Promise<string> {
		const client = await this.client();
		const res = await client.chat.completions.create({
			model: this.model(opts),
			messages: this.toMessages(messages, opts?.system),
			temperature: opts?.temperature,
			max_tokens: opts?.maxTokens
		});
		return res.choices?.[0]?.message?.content ?? '';
	}

	async json<T = unknown>(messages: ChatMessage[], opts?: JsonOptions): Promise<T> {
		const client = await this.client();
		const res = await client.chat.completions.create({
			model: this.model(opts),
			messages: this.toMessages(messages, [opts?.system, schemaInstruction(opts?.schema)].filter(Boolean).join('\n\n')),
			temperature: opts?.temperature ?? 0,
			// json_object is the broadly-supported structured mode across the family.
			response_format: { type: 'json_object' }
		});
		return parseJsonLoose<T>(res.choices?.[0]?.message?.content ?? '');
	}

	async embed(input: string | string[], opts?: { model?: string; dimensions?: number }): Promise<number[][] | null> {
		if (!this.supportsEmbeddings) return null;
		const client = await this.client();
		const res = await client.embeddings.create({
			model: opts?.model ?? this.embedModel,
			input,
			...(opts?.dimensions ? { dimensions: opts.dimensions } : {})
		});
		return res.data.map((d) => d.embedding as number[]);
	}
}
