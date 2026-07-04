import { env } from '$env/dynamic/private';
import type { CopilotMode } from '@insightlibrary/schemas';

/**
 * Server-side Gemini access. The API key lives ONLY here (never shipped to any
 * client). When GEMINI_API_KEY is absent, a deterministic mock stream is used so
 * the copilot works end-to-end in local dev without a key.
 */

const MODE_SYSTEM_PROMPTS: Record<CopilotMode, string> = {
	ask: 'Answer helpfully and concisely.',
	strict_citation: 'Answer ONLY from provided sources. Every claim must carry an inline citation like [bk-A p12]. If unsupported, say so.',
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
}

/** Async generator of response text chunks. Real Gemini stream or mock. */
export async function* streamCopilot(
	input: CopilotStreamInput
): AsyncGenerator<string, void, unknown> {
	const system = MODE_SYSTEM_PROMPTS[input.mode];

	if (!env.GEMINI_API_KEY) {
		yield* mockStream(input, system);
		return;
	}

	const { GoogleGenAI } = await import('@google/genai');
	const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
	const prompt = input.context
		? `${system}\n\nSOURCES:\n${input.context}\n\nUSER: ${input.message}`
		: `${system}\n\nUSER: ${input.message}`;

	const stream = await ai.models.generateContentStream({
		model: 'gemini-2.5-flash',
		contents: prompt
	});
	for await (const chunk of stream) {
		const text = chunk.text;
		if (text) yield text;
	}
}

/** Deterministic mock stream — used when no GEMINI_API_KEY is configured. */
async function* mockStream(
	input: CopilotStreamInput,
	system: string
): AsyncGenerator<string, void, unknown> {
	const sentences = [
		`[${input.mode}] `,
		`I searched the SSOT and knowledge graph for "${input.message}". `,
		'In a configured deployment this response streams live from Gemini through the backend (the API key never reaches the client). ',
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
