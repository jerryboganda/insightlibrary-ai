/**
 * Parser router. Default = heuristic (pure JS, zero cost). Mode precedence:
 * explicit opts.mode > org settings (admin Pipeline card, itself falling back
 * to the PARSE_MODE env var) > 'heuristic'. Modes: 'document-ai' (provider
 * extracts tables/figures) or 'external' (paid LlamaParse). Both degrade to
 * heuristic when unconfigured.
 */
import type { ParsedDoc } from './types';
import { parseHeuristic } from './heuristic';
import { parseDocumentAi } from './document-ai';
import { parseExternal } from './external';
import { getOrgSettings } from '../../org-settings';

export interface ParseOptions {
	mode?: 'heuristic' | 'document-ai' | 'external';
	/** Org whose settings decide the default mode (ingestion jobs pass the doc's org). */
	orgId?: string;
}

export async function parseDocument(bytes: Uint8Array, filename: string, opts: ParseOptions = {}): Promise<ParsedDoc> {
	const mode =
		opts.mode ??
		(await getOrgSettings(opts.orgId ?? 'org_1').catch(() => null))?.parseMode ??
		(process.env.PARSE_MODE as ParseOptions['mode']) ??
		'heuristic';
	if (mode === 'document-ai') return parseDocumentAi(bytes, filename, opts.orgId ?? 'org_1');
	if (mode === 'external') return parseExternal(bytes, filename);
	return parseHeuristic(bytes, filename);
}

export type { ParsedDoc, ParsedBlock, ParsedPage, BlockKind } from './types';
