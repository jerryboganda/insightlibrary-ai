// process.env (not $env/dynamic/private) so this module also loads in the
// standalone pg-boss worker, which runs outside the SvelteKit runtime.

import { getOrgAiRouting } from './providers/org-routing';
import { enforceBudget, recordAiUsage } from '../usage/metering';

/** Embedding dimensionality — must match the pgvector column in db/schema.ts. */
export const EMBEDDING_DIMS = 768;

const EMBED_MODEL = 'gemini-embedding-001';

/**
 * Thrown when NO Gemini key resolves anywhere (org-stored BYO key or env
 * GEMINI_API_KEY). Vector search, dedup, conflict detection and ontology
 * linking are all disabled in that state — callers passing `required: true`
 * get this typed error so they can surface the degradation instead of
 * silently falling back to lexical-only behavior.
 */
export class EmbeddingsUnavailableError extends Error {
	constructor(
		msg = 'No Gemini API key configured (store one in Admin → Settings → AI, or set GEMINI_API_KEY) — embeddings are disabled'
	) {
		super(msg);
		this.name = 'EmbeddingsUnavailableError';
	}
}

export interface EmbedOptions {
	/** Org whose stored BYO key should be used (defaults to the seeded org). */
	orgId?: string;
	/** Throw EmbeddingsUnavailableError instead of returning null when no key resolves. */
	required?: boolean;
}

/**
 * Resolve the Gemini embedding key: org-stored BYO key first (admin/settings/ai
 * → provider_keys, decrypted via the cached org-routing layer), then the env
 * var. Gemini ONLY — the pgvector corpus lives in the gemini-embedding-001 MRL
 * space and mixing providers would corrupt nearest-neighbor semantics.
 */
export async function resolveEmbeddingKey(
	orgId = 'org_1'
): Promise<{ apiKey: string; source: 'stored' | 'env' } | null> {
	try {
		const routing = await getOrgAiRouting(orgId);
		const stored = routing.credentials.gemini;
		if (stored?.apiKey) return { apiKey: stored.apiKey, source: 'stored' };
	} catch {
		/* degrade to env */
	}
	const env = process.env.GEMINI_API_KEY;
	if (env) return { apiKey: env, source: 'env' };
	return null;
}

/** Embeddings health for status endpoints / degradation banners. */
export async function embeddingsStatus(
	orgId = 'org_1'
): Promise<{ configured: boolean; provider: string | null; source: 'stored' | 'env' | null }> {
	const key = await resolveEmbeddingKey(orgId);
	return { configured: !!key, provider: key ? 'gemini' : null, source: key?.source ?? null };
}

let lastUnconfiguredWarn = 0;

/**
 * Compute an embedding for a piece of text via the Gemini embedding API
 * (server-side only), using the org's stored BYO key with env fallback.
 *
 * When no key resolves anywhere: throws EmbeddingsUnavailableError if
 * `required` is set; otherwise logs loudly (throttled) and returns null so
 * existing pipeline/search callers keep their lexical-only (FTS) degradation.
 * Budget hard-limit refusals (BudgetExceededError) propagate to the caller.
 */
export async function embedText(text: string, opts: EmbedOptions = {}): Promise<number[] | null> {
	const orgId = opts.orgId ?? 'org_1';
	const key = await resolveEmbeddingKey(orgId);
	if (!key) {
		if (opts.required) throw new EmbeddingsUnavailableError();
		if (Date.now() - lastUnconfiguredWarn > 60_000) {
			lastUnconfiguredWarn = Date.now();
			console.error(
				'[embeddings] no Gemini key resolves (org-stored or GEMINI_API_KEY) — vector search, dedup, conflict detection and ontology linking are degraded to lexical-only'
			);
		}
		return null;
	}
	// Refuse before spending when the org's monthly hard budget is exhausted.
	await enforceBudget(orgId, 'embedding');

	const startedAt = Date.now();
	const { GoogleGenAI } = await import('@google/genai');
	const ai = new GoogleGenAI({ apiKey: key.apiKey });
	const res = await ai.models.embedContent({
		model: EMBED_MODEL,
		contents: text,
		// Matryoshka truncation to the column dimensionality.
		config: { outputDimensionality: EMBEDDING_DIMS }
	});
	const values = res.embeddings?.[0]?.values;
	if (values) {
		recordAiUsage({
			orgId,
			provider: 'gemini',
			model: EMBED_MODEL,
			task: 'embedding',
			charsIn: text.length,
			charsOut: 0,
			durationMs: Date.now() - startedAt
		});
	}
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
