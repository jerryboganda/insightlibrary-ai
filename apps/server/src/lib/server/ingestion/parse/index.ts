/**
 * Parser router. Default = heuristic (pure JS, zero cost). PARSE_MODE (or
 * opts.mode) selects: 'document-ai' (provider extracts tables/figures) or
 * 'external' (paid LlamaParse). Both degrade to heuristic when unconfigured.
 */
import type { ParsedDoc } from './types';
import { parseHeuristic } from './heuristic';
import { parseDocumentAi } from './document-ai';
import { parseExternal } from './external';

export interface ParseOptions {
	mode?: 'heuristic' | 'document-ai' | 'external';
}

export async function parseDocument(bytes: Uint8Array, filename: string, opts: ParseOptions = {}): Promise<ParsedDoc> {
	const mode = opts.mode ?? (process.env.PARSE_MODE as ParseOptions['mode']) ?? 'heuristic';
	if (mode === 'document-ai') return parseDocumentAi(bytes, filename);
	if (mode === 'external') return parseExternal(bytes, filename);
	return parseHeuristic(bytes, filename);
}

export type { ParsedDoc, ParsedBlock, ParsedPage, BlockKind } from './types';
