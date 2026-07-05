/**
 * ChatGPT (OAuth) adapter — speaks the OpenAI Responses API shape with the
 * user's OAuth bearer token, targeting the ChatGPT backend Codex endpoint.
 *
 * EXPERIMENTAL / off-label: reusing a consumer ChatGPT subscription for
 * programmatic use is not officially supported and may break at any time. The
 * token is forwarded per-request (never persisted server-side).
 */
import type { ChatMessage, ChatOptions, Credential, JsonOptions, LlmProvider } from './types';
import { parseJsonLoose, schemaInstruction } from './util';

interface ResponseInputItem {
	role: 'user' | 'assistant';
	content: { type: 'input_text' | 'output_text'; text: string }[];
}

export class ChatGptCodexProvider implements LlmProvider {
	readonly id = 'chatgpt-oauth' as const;
	constructor(private cred: Credential) {}

	private endpoint(): string {
		return this.cred.baseUrl ?? process.env.CHATGPT_CODEX_URL ?? 'https://chatgpt.com/backend-api/codex/responses';
	}
	private model(opts?: ChatOptions): string {
		return opts?.model ?? this.cred.model ?? process.env.CHATGPT_CODEX_MODEL ?? 'gpt-5';
	}

	private build(messages: ChatMessage[], system?: string): { instructions?: string; input: ResponseInputItem[] } {
		const sys = [system, ...messages.filter((m) => m.role === 'system').map((m) => m.content)].filter(Boolean).join('\n\n');
		const input: ResponseInputItem[] = messages
			.filter((m) => m.role !== 'system')
			.map((m) => ({
				role: m.role === 'assistant' ? 'assistant' : 'user',
				content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.content }]
			}));
		return { instructions: sys || undefined, input };
	}

	async *chatStream(messages: ChatMessage[], opts?: ChatOptions): AsyncGenerator<string, void, unknown> {
		const { instructions, input } = this.build(messages, opts?.system);
		const res = await fetch(this.endpoint(), {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${this.cred.oauthToken ?? ''}`,
				'Content-Type': 'application/json',
				Accept: 'text/event-stream'
			},
			body: JSON.stringify({ model: this.model(opts), instructions, input, stream: true })
		});
		if (!res.ok || !res.body) throw new Error(`chatgpt-codex ${res.status}`);

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const parts = buffer.split('\n\n');
			buffer = parts.pop() ?? '';
			for (const part of parts) {
				const line = part.split('\n').find((l) => l.startsWith('data:'));
				if (!line) continue;
				const data = line.slice(5).trim();
				if (data === '[DONE]') return;
				try {
					const ev = JSON.parse(data) as { type?: string; delta?: unknown };
					if (typeof ev.delta === 'string' && (!ev.type || ev.type.endsWith('output_text.delta'))) {
						yield ev.delta;
					}
				} catch {
					/* ignore non-JSON keep-alive frames */
				}
			}
		}
	}

	async complete(messages: ChatMessage[], opts?: ChatOptions): Promise<string> {
		let out = '';
		for await (const t of this.chatStream(messages, opts)) out += t;
		return out;
	}

	async json<T = unknown>(messages: ChatMessage[], opts?: JsonOptions): Promise<T> {
		const text = await this.complete(messages, {
			...opts,
			system: [opts?.system, schemaInstruction(opts?.schema)].filter(Boolean).join('\n\n')
		});
		return parseJsonLoose<T>(text);
	}
}
