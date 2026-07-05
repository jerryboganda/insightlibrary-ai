/**
 * Central refinery thresholds — two layers:
 *
 *  - getRefineryConfig(orgId): the live, admin-manageable values resolved from
 *    the org_settings store (env-var defaults, short-TTL cached). Runtime paths
 *    (dedup/conflict/correlate/rerank/parse) use this, so edits on the admin
 *    Governance page apply within seconds — no restart, worker included.
 *
 *  - REFINERY_CONFIG: the env-only snapshot evaluated at module load. Kept for
 *    compatibility (eval harness / fallback when the settings store is
 *    unreachable); values match orgSettingsDefaults() at boot.
 */
import { getOrgSettings, type ParseMode, type RerankMode } from '../org-settings';

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

export interface RefineryConfig {
	dedupCosine: number;
	dedupUseNli: boolean;
	conflictSubjectCosine: number;
	conflictEnabled: boolean;
	maxCorrelateClaims: number;
	rerank: RerankMode;
	/** Freeze contradicting claims as 'conflicted' until human review. */
	requireReview: boolean;
	/** NLI confidence (0–100) required to auto-merge duplicates; 0 = always. */
	autoMergeConfidence: number;
	parseMode: ParseMode;
}

/** Live per-org refinery config (org_settings overlay over env defaults). */
export async function getRefineryConfig(orgId = 'org_1'): Promise<RefineryConfig> {
	const s = await getOrgSettings(orgId);
	return {
		dedupCosine: s.dedupCosine,
		dedupUseNli: s.dedupUseNli,
		conflictSubjectCosine: s.conflictSubjectCosine,
		conflictEnabled: s.conflictEnabled,
		maxCorrelateClaims: s.maxCorrelateClaims,
		rerank: s.rerank,
		requireReview: s.requireReview,
		autoMergeConfidence: s.autoMergeConfidence,
		parseMode: s.parseMode
	};
}
