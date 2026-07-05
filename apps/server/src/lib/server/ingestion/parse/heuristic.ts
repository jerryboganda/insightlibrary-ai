/**
 * Default structure-aware parser — pure JS, zero new deps. Extracts per-PAGE
 * text (unpdf mergePages:false), segments each page into blocks (heading vs
 * paragraph heuristic), and assigns reading order. No bbox in this path; the
 * optional document-AI path (Phase 3) adds tables/figures/coordinates.
 */
import type { ParsedBlock, ParsedDoc, ParsedPage } from './types';

function segment(pageText: string, page: number, startOrder: number): ParsedBlock[] {
	const blocks: ParsedBlock[] = [];
	let order = startOrder;
	const paras = pageText
		.split(/\n\s*\n+/)
		.map((s) => s.replace(/[ \t]+/g, ' ').trim())
		.filter(Boolean);
	for (const p of paras) {
		const oneLine = !p.includes('\n');
		const isHeading = oneLine && p.length <= 80 && !/[.!?:]$/.test(p) && /[A-Za-z]/.test(p);
		blocks.push({ kind: isHeading ? 'heading' : 'text', page, readingOrder: order++, content: p, confidence: 0.6 });
	}
	return blocks;
}

export async function parseHeuristic(bytes: Uint8Array, filename: string): Promise<ParsedDoc> {
	const lower = filename.toLowerCase();
	const pages: ParsedPage[] = [];
	const blocks: ParsedBlock[] = [];
	let order = 0;

	if (lower.endsWith('.pdf')) {
		const { extractText, getDocumentProxy } = await import('unpdf');
		const pdf = await getDocumentProxy(bytes);
		const { text } = await extractText(pdf, { mergePages: false });
		const pageTexts = Array.isArray(text) ? text : [text];
		pageTexts.forEach((pt, i) => {
			pages.push({ pageNo: i + 1 });
			const bs = segment(pt ?? '', i + 1, order);
			order += bs.length;
			blocks.push(...bs);
		});
	} else if (lower.endsWith('.epub')) {
		const JSZip = (await import('jszip')).default;
		const zip = await JSZip.loadAsync(bytes);
		const files = Object.keys(zip.files)
			.filter((f) => /\.(x?html?)$/i.test(f))
			.sort();
		let pageNo = 0;
		for (const f of files) {
			pageNo++;
			const raw = await zip.files[f].async('string');
			const clean = raw.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ');
			pages.push({ pageNo });
			const bs = segment(clean, pageNo, order);
			order += bs.length;
			blocks.push(...bs);
		}
	} else {
		const clean = new TextDecoder().decode(bytes);
		pages.push({ pageNo: 1 });
		const bs = segment(clean, 1, order);
		order += bs.length;
		blocks.push(...bs);
	}

	const text = blocks.map((b) => b.content).join('\n\n');
	return { pages, blocks, text };
}
