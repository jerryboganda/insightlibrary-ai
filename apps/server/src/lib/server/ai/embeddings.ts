// process.env (not $env/dynamic/private) so this module also loads in the
// standalone pg-boss worker, which runs outside the SvelteKit runtime.

/** Embedding dimensionality — must match the pgvector column in db/schema.ts. */
export const EMBEDDING_DIMS = 768;

/**
 * Compute an embedding for a piece of text via the Gemini embedding API
 * (server-side only). Returns null when no GEMINI_API_KEY is configured, in
 * which case callers fall back to lexical-only (FTS) search/indexing.
 */
export async function embedText(text: string): Promise<number[] | null> {
	const apiKey = process.env.GEMINI_API_KEY;
	if (!apiKey) return null;
	const { GoogleGenAI } = await import('@google/genai');
	const ai = new GoogleGenAI({ apiKey });
	const res = await ai.models.embedContent({
		model: 'gemini-embedding-001',
		contents: text,
		// Matryoshka truncation to the column dimensionality.
		config: { outputDimensionality: EMBEDDING_DIMS }
	});
	const values = res.embeddings?.[0]?.values;
	return values ?? null;
}

/**
 * Split document text into overlapping semantic chunks (~char-bounded).
 * A production system would chunk on sentence/heading boundaries; this keeps
 * the pipeline dependency-free while producing coherent, indexable units.
 */
export function chunkText(text: string, target = 800, overlap = 120): string[] {
	const clean = text.replace(/\s+/g, ' ').trim();
	if (!clean) return [];
	const chunks: string[] = [];
	let start = 0;
	while (start < clean.length) {
		let end = Math.min(start + target, clean.length);
		// Prefer to break at a sentence boundary within the window.
		if (end < clean.length) {
			const dot = clean.lastIndexOf('. ', end);
			if (dot > start + target / 2) end = dot + 1;
		}
		chunks.push(clean.slice(start, end).trim());
		if (end >= clean.length) break;
		// Guarantee forward progress even if a caller passes overlap >= step.
		start = Math.max(end - overlap, start + 1);
	}
	return chunks;
}
