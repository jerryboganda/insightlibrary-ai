/**
 * External paid parser path (LlamaParse) — highest-fidelity tables/figures for
 * the hardest documents. Behind LLAMAPARSE_API_KEY; falls back to the heuristic
 * parser when unset or on error. Enabled by PARSE_MODE=external (or opts.mode).
 */
import type { ParsedDoc, ParsedBlock } from './types';
import { parseHeuristic } from './heuristic';

const BASE = process.env.LLAMAPARSE_URL ?? 'https://api.cloud.llamaindex.ai/api/v1/parsing';

async function llamaParse(bytes: Uint8Array, filename: string, key: string): Promise<string | null> {
	const form = new FormData();
	form.append('file', new Blob([bytes as unknown as BlobPart]), filename);
	const up = await fetch(`${BASE}/upload`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
		body: form
	});
	if (!up.ok) throw new Error(`llamaparse upload ${up.status}`);
	const { id } = (await up.json()) as { id: string };

	// Poll for completion (bounded).
	for (let i = 0; i < 60; i++) {
		const st = await fetch(`${BASE}/job/${id}`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
		const job = (await st.json()) as { status: string };
		if (job.status === 'SUCCESS') break;
		if (job.status === 'ERROR') throw new Error('llamaparse job failed');
		await new Promise((r) => setTimeout(r, 2000));
	}
	const res = await fetch(`${BASE}/job/${id}/result/markdown`, {
		headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }
	});
	if (!res.ok) throw new Error(`llamaparse result ${res.status}`);
	const out = (await res.json()) as { markdown?: string };
	return out.markdown ?? null;
}

export async function parseExternal(bytes: Uint8Array, filename: string): Promise<ParsedDoc> {
	const key = process.env.LLAMAPARSE_API_KEY;
	if (!key) return parseHeuristic(bytes, filename);
	try {
		const markdown = await llamaParse(bytes, filename, key);
		if (!markdown) return parseHeuristic(bytes, filename);
		// Split the returned markdown into page/section blocks on horizontal rules /
		// blank lines; pages aren't recoverable from markdown, so treat as page 1.
		const blocks: ParsedBlock[] = markdown
			.split(/\n-{3,}\n|\n\s*\n/)
			.map((s) => s.trim())
			.filter(Boolean)
			.map((content, i) => ({
				kind: /\|.*\|/.test(content) ? 'table' : content.length < 80 && !/[.!?]$/.test(content) ? 'heading' : 'text',
				page: 1,
				readingOrder: i,
				content,
				confidence: 0.85
			}));
		return { pages: [{ pageNo: 1 }], blocks, text: blocks.map((b) => b.content).join('\n\n') };
	} catch {
		return parseHeuristic(bytes, filename);
	}
}
