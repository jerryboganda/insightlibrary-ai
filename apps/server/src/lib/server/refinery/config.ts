/**
 * Central refinery thresholds — the single owner (Eval imports these rather than
 * hardcoding, so the harness measures the system as actually configured).
 */
export const REFINERY_CONFIG = {
	/** Cosine similarity above which two claims are dedup candidates. */
	dedupCosine: Number(process.env.DEDUP_COSINE ?? '0.9'),
	/** Gate dedup on an LLM equivalence (NLI) check in addition to cosine. */
	dedupUseNli: (process.env.DEDUP_NLI ?? 'true') !== 'false',
	/** Cosine above which two claims are considered the same subject (for conflict). */
	conflictSubjectCosine: Number(process.env.CONFLICT_SUBJECT_COSINE ?? '0.55'),
	conflictEnabled: (process.env.CONFLICT_DETECT ?? 'true') !== 'false',
	/** Max claims per document to correlate (cost guard). */
	maxCorrelateClaims: Number(process.env.CORRELATE_MAX_CLAIMS ?? '120'),
	/** Rerank backend: off | llm | cohere | jina. */
	rerank: (process.env.RERANK ?? 'off') as 'off' | 'llm' | 'cohere' | 'jina'
};
