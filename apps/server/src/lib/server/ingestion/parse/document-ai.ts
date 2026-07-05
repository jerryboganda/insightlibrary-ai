/**
 * Document-AI parse path — enriches the heuristic parse with provider-extracted
 * TABLES (as markdown) and FIGURE captions per page (structured output). Runs
 * server-side via the provider layer; skipped silently without a provider.
 * Enabled by PARSE_MODE=document-ai (or opts.mode).
 */
import type { ParsedDoc } from './types';
import { parseHeuristic } from './heuristic';
import { getRouter } from '../../ai/providers';
import { getOrgSettings } from '../../org-settings';

const PARSE_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		tables: {
			type: 'array',
			items: { type: 'object', properties: { title: { type: 'string' }, markdown: { type: 'string' } }, required: ['markdown'] }
		},
		figures: {
			type: 'array',
			items: { type: 'object', properties: { caption: { type: 'string' } }, required: ['caption'] }
		}
	},
	required: ['tables', 'figures']
};

export async function parseDocumentAi(bytes: Uint8Array, filename: string, orgId = 'org_1'): Promise<ParsedDoc> {
	const base = await parseHeuristic(bytes, filename);
	const router = getRouter(orgId);
	if (!router.available('extraction')) return base;

	// Admin-tunable page cap (org settings; falls back to PARSE_AI_MAX_PAGES env,
	// then the built-in default) instead of reading the env var directly.
	const cap = (await getOrgSettings(orgId).catch(() => null))?.parseAiMaxPages ?? Number(process.env.PARSE_AI_MAX_PAGES ?? '20');
	const byPage = new Map<number, string>();
	for (const b of base.blocks) byPage.set(b.page, `${byPage.get(b.page) ?? ''}${b.content}\n`);

	let order = base.blocks.length;
	let processed = 0;
	for (const [page, text] of byPage) {
		if (processed >= cap) break;
		if (!/\d[\s\S]*\d/.test(text)) continue; // pages with no numbers rarely have tables
		processed++;
		const res = await router
			.json<{ tables: { title?: string; markdown: string }[]; figures: { caption: string }[] }>(
				[
					{
						role: 'user',
						content:
							'From this page text, extract any TABLES as GitHub-flavored markdown and any FIGURE captions. ' +
							'Return JSON {"tables":[{title?,markdown}],"figures":[{caption}]} — empty arrays if none.\n\n' +
							text.slice(0, 3000)
					}
				],
				{ task: 'extraction', schema: PARSE_SCHEMA, temperature: 0 }
			)
			.catch(() => null);
		if (!res) continue;
		for (const t of res.tables ?? []) {
			if (!t.markdown?.trim()) continue;
			base.blocks.push({ kind: 'table', page, readingOrder: order++, content: (t.title ? `${t.title}\n` : '') + t.markdown, confidence: 0.75 });
		}
		for (const f of res.figures ?? []) {
			if (!f.caption?.trim()) continue;
			base.blocks.push({ kind: 'figure', page, readingOrder: order++, content: f.caption, confidence: 0.7 });
		}
	}

	base.text = base.blocks.map((b) => b.content).join('\n\n');
	return base;
}
