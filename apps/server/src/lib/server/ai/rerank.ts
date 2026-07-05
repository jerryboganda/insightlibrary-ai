/**
 * Cross-encoder reranking of fused search candidates. Default is 'off' (zero
 * behavior change). Backends: 'cohere'/'jina' (paid REST APIs, toggled by key)
 * and 'llm' (free, via the provider layer). Returns a map id → rerank score;
 * an empty map means "no reranking applied".
 */
import { getRouter } from './providers';
import { REFINERY_CONFIG } from '../refinery/config';

export interface RerankItem {
	id: string;
	text: string;
}

export async function rerankResults(query: string, items: RerankItem[]): Promise<Map<string, number>> {
	const mode = REFINERY_CONFIG.rerank;
	if (mode === 'off' || items.length === 0) return new Map();
	try {
		if (mode === 'cohere') return await cohereRerank(query, items);
		if (mode === 'jina') return await jinaRerank(query, items);
		if (mode === 'llm') return await llmRerank(query, items);
	} catch (e) {
		console.error('[rerank] failed:', e instanceof Error ? e.message : e);
	}
	return new Map();
}

async function cohereRerank(query: string, items: RerankItem[]): Promise<Map<string, number>> {
	const key = process.env.COHERE_API_KEY;
	if (!key) return new Map();
	const res = await fetch('https://api.cohere.com/v2/rerank', {
		method: 'POST',
		headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ model: process.env.COHERE_RERANK_MODEL ?? 'rerank-v3.5', query, documents: items.map((i) => i.text) })
	});
	if (!res.ok) throw new Error(`cohere ${res.status}`);
	const data = (await res.json()) as { results: { index: number; relevance_score: number }[] };
	const out = new Map<string, number>();
	for (const r of data.results) if (items[r.index]) out.set(items[r.index].id, r.relevance_score);
	return out;
}

async function jinaRerank(query: string, items: RerankItem[]): Promise<Map<string, number>> {
	const key = process.env.JINA_API_KEY;
	if (!key) return new Map();
	const res = await fetch('https://api.jina.ai/v1/rerank', {
		method: 'POST',
		headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ model: process.env.JINA_RERANK_MODEL ?? 'jina-reranker-v2-base-multilingual', query, documents: items.map((i) => i.text) })
	});
	if (!res.ok) throw new Error(`jina ${res.status}`);
	const data = (await res.json()) as { results: { index: number; relevance_score: number }[] };
	const out = new Map<string, number>();
	for (const r of data.results) if (items[r.index]) out.set(items[r.index].id, r.relevance_score);
	return out;
}

const LLM_RERANK_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		scores: {
			type: 'array',
			items: { type: 'object', properties: { index: { type: 'number' }, score: { type: 'number' } }, required: ['index', 'score'] }
		}
	},
	required: ['scores']
};

async function llmRerank(query: string, items: RerankItem[]): Promise<Map<string, number>> {
	const router = getRouter();
	if (!router.available('rerank')) return new Map();
	const list = items.map((it, i) => `[${i}] ${it.text.slice(0, 400)}`).join('\n');
	const res = await router
		.json<{ scores: { index: number; score: number }[] }>(
			[
				{
					role: 'user',
					content:
						`Query: "${query}"\n\nRate each passage's relevance to the query from 0 (irrelevant) to 1 (perfectly relevant). ` +
						`Return JSON {"scores":[{index, score}]}.\n\n${list}`
				}
			],
			{ task: 'rerank', schema: LLM_RERANK_SCHEMA, temperature: 0 }
		)
		.catch(() => null);
	const out = new Map<string, number>();
	if (!res?.scores) return out;
	for (const s of res.scores) if (items[s.index]) out.set(items[s.index].id, s.score);
	return out;
}
