import type { ChatMessage } from './types';

/**
 * Parse JSON that may arrive wrapped in ```json fences or with leading prose.
 * Used by adapters whose providers lack native structured output.
 */
export function parseJsonLoose<T = unknown>(text: string): T {
	const trimmed = text.trim();
	// Strip code fences.
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const body = fenced ? fenced[1].trim() : trimmed;
	try {
		return JSON.parse(body) as T;
	} catch {
		// Fall back to the first balanced {...} or [...] block.
		const start = body.search(/[[{]/);
		if (start >= 0) {
			const open = body[start];
			const close = open === '{' ? '}' : ']';
			let depth = 0;
			for (let i = start; i < body.length; i++) {
				if (body[i] === open) depth++;
				else if (body[i] === close) {
					depth--;
					if (depth === 0) return JSON.parse(body.slice(start, i + 1)) as T;
				}
			}
		}
		throw new Error('provider returned non-JSON output');
	}
}

/** Split a message list into a system string + non-system turns (for Anthropic). */
export function splitSystem(messages: ChatMessage[], extra?: string): { system: string; turns: ChatMessage[] } {
	const sys = messages.filter((m) => m.role === 'system').map((m) => m.content);
	if (extra) sys.unshift(extra);
	return {
		system: sys.join('\n\n'),
		turns: messages.filter((m) => m.role !== 'system')
	};
}

/** Append a JSON-schema instruction to the system prompt for non-native providers. */
export function schemaInstruction(schema?: Record<string, unknown>): string {
	if (!schema) return 'Respond with a single valid JSON value and nothing else.';
	return (
		'Respond with a single valid JSON value and nothing else — no prose, no code fences. ' +
		'It MUST conform to this JSON Schema:\n' +
		JSON.stringify(schema)
	);
}
