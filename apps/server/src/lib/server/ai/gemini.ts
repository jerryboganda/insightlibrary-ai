import type { CopilotMode } from '@insightlibrary/schemas';
import { getRouter, type ChatMessage, type RouteContext } from './providers';

/**
 * Copilot streaming — now provider-agnostic. Builds the mode system prompt and
 * streams through the multi-provider router (Gemini / Claude / OpenAI / Kimi /
 * DeepSeek / MiniMax / OpenAI-compatible). When no provider key is configured a
 * deterministic mock stream is used so the copilot works with zero external
 * services (unchanged behavior). Kept at this path so /api/copilot is untouched.
 */

const MODE_SYSTEM_PROMPTS: Record<CopilotMode, string> = {
	ask: 'Answer helpfully and concisely.',
	strict_citation:
		'Answer ONLY from provided sources. Every claim must carry an inline citation like [bk-A p12]. If unsupported, say so.',
	research: 'Explore the question broadly, surface related topics, and suggest follow-up threads.',
	compare: 'Compare the entities/sources side by side, highlighting agreements and contradictions.',
	contradiction: 'Focus on detecting and explaining contradictions across sources.',
	study: 'Explain for a learner. Offer a concise summary then key points to remember.',
	teacher: 'Adopt a Socratic teaching tone; check understanding with a question.',
	exam: 'Produce exam-style Q&A and high-yield pearls.',
	summarize: 'Summarize the material into a tight outline.',
	deep_reasoning: 'Reason step by step and show the chain of reasoning before the conclusion.',
	fast_answer: 'Give the shortest correct answer with no preamble.',
	ssot: 'Answer strictly from the canonical single source of truth for the topic.',
	delta: 'Report only what changed: new, expanded, duplicate, or conflicting claims.'
};

export interface CopilotStreamInput {
	mode: CopilotMode;
	message: string;
	context?: string;
	/** Optional per-request credential (stored key / forwarded OAuth token). */
	ctx?: RouteContext;
}

/** Async generator of response text chunks. Real provider stream or mock. */
export async function* streamCopilot(input: CopilotStreamInput): AsyncGenerator<string, void, unknown> {
	const system = MODE_SYSTEM_PROMPTS[input.mode];
	const router = getRouter();

	if (!router.available('chat', input.ctx)) {
		yield* mockStream(input, system);
		return;
	}

	const userContent = input.context
		? `SOURCES:\n${input.context}\n\nUSER: ${input.message}`
		: input.message;
	const messages: ChatMessage[] = [{ role: 'user', content: userContent }];
	yield* router.chatStream(messages, { task: 'chat', system, ctx: input.ctx });
}

/** Deterministic mock stream — used when no provider key is configured. */
async function* mockStream(input: CopilotStreamInput, system: string): AsyncGenerator<string, void, unknown> {
	const sentences = [
		`[${input.mode}] `,
		`I searched the SSOT and knowledge graph for "${input.message}". `,
		'In a configured deployment this response streams live from your selected provider through the backend (the API key never reaches the client). ',
		input.mode === 'strict_citation'
			? 'Example grounded answer: hydrocortisone replacement is typically 15–25 mg/day [bk-B p55]. '
			: 'This is a local mock so the copilot works with zero external services. ',
		`Mode directive in effect: "${system}"`
	];
	for (const s of sentences) {
		for (const word of s.split(/(\s+)/)) {
			yield word;
			await new Promise((r) => setTimeout(r, 12));
		}
	}
}
