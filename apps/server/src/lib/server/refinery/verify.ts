/**
 * The verifier — the single shared owner of sentence-grounding checks (Synthesis
 * publish gate AND Eval hallucination scoring reuse this). A composed sentence
 * is supported iff it cites at least one real evidence claim and (strict mode)
 * an NLI entailment check confirms the evidence supports it. Unsupported
 * sentences are dropped/flagged.
 */
import { getRouter } from '../ai/providers';
import { classifyPair } from './nli';
import type { ClaimEvidence } from './retrieve';

export interface ComposedSentence {
	content: string;
	citationClaimIds: string[];
}

export interface VerifyResult {
	supported: { content: string; citations: string[] }[];
	total: number;
	dropped: number;
	faithfulness: number;
}

export async function verifySentences(
	sentences: ComposedSentence[],
	evidenceById: Map<string, ClaimEvidence>,
	opts: { strict?: boolean } = {}
): Promise<VerifyResult> {
	const router = getRouter();
	const useNli = !!opts.strict && router.available('nli');
	const supported: { content: string; citations: string[] }[] = [];
	let ok = 0;

	for (const s of sentences) {
		const cited = (s.citationClaimIds ?? []).filter((id) => evidenceById.has(id));
		if (!cited.length) continue; // no valid citation → unsupported, drop

		let entailed = true;
		if (useNli) {
			const evidenceText = cited.map((id) => evidenceById.get(id)!.text).join(' ');
			const rel = await classifyPair(evidenceText, s.content).catch(() => null);
			entailed = rel ? rel.relation === 'equivalent' || rel.relation === 'entailment' : true;
		}
		if (!entailed) continue;

		const citations = cited.flatMap((id) => evidenceById.get(id)!.citations);
		supported.push({ content: s.content, citations });
		ok++;
	}

	return { supported, total: sentences.length, dropped: sentences.length - ok, faithfulness: sentences.length ? ok / sentences.length : 1 };
}
