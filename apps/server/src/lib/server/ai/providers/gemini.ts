/**
 * Gemini adapter (native @google/genai). Handles chat streaming, completion,
 * native structured output (responseSchema) and 768-dim embeddings.
 */
import type { ChatMessage, ChatOptions, Credential, JsonOptions, LlmProvider } from './types';
import { parseJsonLoose } from './util';

// Gemini uses role 'model' for the assistant and merges system via systemInstruction.
function toContents(messages: ChatMessage[]): { role: 'user' | 'model'; parts: { text: string }[] }[] {
	return messages
		.filter((m) => m.role !== 'system')
		.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
}

function systemText(messages: ChatMessage[], extra?: string): string | undefined {
	const parts = messages.filter((m) => m.role === 'system').map((m) => m.content);
	if (extra) parts.unshift(extra);
	return parts.length ? parts.join('\n\n') : undefined;
}

export class GeminiProvider implements LlmProvider {
	readonly id = 'gemini' as const;
	constructor(private cred: Credential) {}

	private async client() {
		const { GoogleGenAI } = await import('@google/genai');
		return new GoogleGenAI({ apiKey: this.cred.apiKey });
	}

	private model(opts?: ChatOptions) {
		return opts?.model ?? this.cred.model ?? 'gemini-2.5-flash';
	}

	async *chatStream(messages: ChatMessage[], opts?: ChatOptions): AsyncGenerator<string, void, unknown> {
		const ai = await this.client();
		const stream = await ai.models.generateContentStream({
			model: this.model(opts),
			contents: toContents(messages),
			config: {
				systemInstruction: systemText(messages, opts?.system),
				temperature: opts?.temperature
			}
		});
		for await (const chunk of stream) {
			const text = chunk.text;
			if (text) yield text;
		}
	}

	async complete(messages: ChatMessage[], opts?: ChatOptions): Promise<string> {
		const ai = await this.client();
		const res = await ai.models.generateContent({
			model: this.model(opts),
			contents: toContents(messages),
			config: {
				systemInstruction: systemText(messages, opts?.system),
				temperature: opts?.temperature
			}
		});
		return res.text ?? '';
	}

	async json<T = unknown>(messages: ChatMessage[], opts?: JsonOptions): Promise<T> {
		const ai = await this.client();
		const res = await ai.models.generateContent({
			model: this.model(opts),
			contents: toContents(messages),
			config: {
				systemInstruction: systemText(messages, opts?.system),
				temperature: opts?.temperature ?? 0,
				responseMimeType: 'application/json',
				// @google/genai accepts a JSON-schema-like object here.
				...(opts?.schema ? { responseSchema: opts.schema as object } : {})
			}
		});
		return parseJsonLoose<T>(res.text ?? '');
	}

	async embed(input: string | string[], opts?: { model?: string; dimensions?: number }): Promise<number[][] | null> {
		const ai = await this.client();
		const items = Array.isArray(input) ? input : [input];
		const out: number[][] = [];
		for (const text of items) {
			const res = await ai.models.embedContent({
				model: opts?.model ?? 'gemini-embedding-001',
				contents: text,
				config: { outputDimensionality: opts?.dimensions ?? 768 }
			});
			const values = res.embeddings?.[0]?.values;
			if (!values) return null;
			out.push(values);
		}
		return out;
	}
}
