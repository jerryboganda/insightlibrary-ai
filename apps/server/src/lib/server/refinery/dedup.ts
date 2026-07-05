/**
 * Deduplication: two claims are the same iff high cosine similarity of
 * normalized_meaning AND (optionally) an LLM equivalence check agrees. On a
 * match, provenance is merged onto the canonical claim and the duplicate is
 * marked superseded — keeping the graph small without losing any source.
 */
import { eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { claims, claimSources } from '../db/schema';
import { getRefineryConfig } from './config';
import { classifyPair } from './nli';

export async function dedupClaim(claimId: string, orgId: string): Promise<{ merged: boolean; canonicalId?: string }> {
	const db = getDb();
	if (!db) return { merged: false };
	// Live org-scoped thresholds (admin Governance page), env defaults otherwise.
	const cfg = await getRefineryConfig(orgId);
	const [c] = await db.select().from(claims).where(eq(claims.id, claimId));
	if (!c || !c.normalizedMeaning || c.status !== 'active') return { merged: false };

	const literal = `[${(c.normalizedMeaning as number[]).join(',')}]`;
	const cands = await db.execute<{ id: string; claim_text: string; dist: number }>(sql`
		SELECT id, claim_text, normalized_meaning <=> ${literal}::vector AS dist
		FROM claims
		WHERE org_id = ${orgId} AND id <> ${claimId} AND status = 'active'
		  AND normalized_meaning IS NOT NULL
		  AND topic_id IS NOT DISTINCT FROM ${c.topicId}
		ORDER BY normalized_meaning <=> ${literal}::vector
		LIMIT 5
	`);

	for (const cand of cands.rows) {
		const cosine = 1 - Number(cand.dist);
		if (cosine < cfg.dedupCosine) break; // sorted → no closer candidates left
		let equivalent = true;
		if (cfg.dedupUseNli) {
			const rel = await classifyPair(c.claimText, cand.claim_text);
			// Governance auto-merge threshold: merge only when the NLI equivalence
			// confidence clears it (0 = merge every equivalent pair, the historical
			// behavior; higher values leave low-confidence duplicates unmerged).
			equivalent = rel
				? rel.relation === 'equivalent' && (rel.confidence ?? 1) * 100 >= cfg.autoMergeConfidence
				: cosine >= 0.97;
		}
		if (equivalent) {
			// Merge provenance onto the canonical (earlier) claim; supersede this one.
			await db.update(claimSources).set({ claimId: cand.id }).where(eq(claimSources.claimId, claimId));
			await db
				.update(claims)
				.set({ status: 'superseded', supersedesClaimId: cand.id, updatedAt: new Date() })
				.where(eq(claims.id, claimId));
			return { merged: true, canonicalId: cand.id };
		}
	}
	return { merged: false };
}
