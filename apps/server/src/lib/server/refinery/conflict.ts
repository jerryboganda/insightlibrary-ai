/**
 * Conflict detection: same-subject claims that contradict are flagged (status
 * 'conflicted'), both kept, and surfaced in the existing human review queue
 * (review_items) rather than silently resolved.
 */
import { eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { claims, reviewItems } from '../db/schema';
import { getRefineryConfig } from './config';
import { classifyPair } from './nli';

export async function detectConflictsForClaim(claimId: string, orgId: string): Promise<{ conflicts: number }> {
	const db = getDb();
	if (!db) return { conflicts: 0 };
	// Live org-scoped thresholds (admin Governance page), env defaults otherwise.
	const cfg = await getRefineryConfig(orgId);
	if (!cfg.conflictEnabled) return { conflicts: 0 };
	const [c] = await db.select().from(claims).where(eq(claims.id, claimId));
	if (!c || !c.normalizedMeaning || c.status !== 'active') return { conflicts: 0 };

	const literal = `[${(c.normalizedMeaning as number[]).join(',')}]`;
	const cands = await db.execute<{ id: string; claim_text: string; document_id: string | null; dist: number }>(sql`
		SELECT id, claim_text, document_id, normalized_meaning <=> ${literal}::vector AS dist
		FROM claims
		WHERE org_id = ${orgId} AND id <> ${claimId} AND status = 'active'
		  AND normalized_meaning IS NOT NULL
		  AND topic_id IS NOT DISTINCT FROM ${c.topicId}
		ORDER BY normalized_meaning <=> ${literal}::vector
		LIMIT 6
	`);

	let conflicts = 0;
	for (const cand of cands.rows) {
		const cosine = 1 - Number(cand.dist);
		if (cosine < cfg.conflictSubjectCosine) break; // not the same subject
		const rel = await classifyPair(c.claimText, cand.claim_text);
		if (rel?.relation === 'contradiction') {
			await db
				.insert(reviewItems)
				.values({
					id: `ri_${claimId}_${cand.id}`,
					orgId,
					topic: c.topicId ?? '',
					type: 'conflict',
					status: 'pending',
					originalClaim: cand.claim_text,
					newClaim: c.claimText,
					sourceA: cand.document_id,
					sourceB: c.documentId ?? '',
					confidence: `${Math.round((rel.confidence ?? 0.5) * 100)}%`,
					notes: cfg.requireReview
						? 'Auto-detected contradiction (NLI)'
						: 'Auto-detected contradiction (NLI) — informational; claims left active per governance policy'
				})
				.onConflictDoNothing();
			// Governance "require review": when enabled (default) both claims are
			// frozen as 'conflicted' until a human resolves the queue item; when
			// disabled the queue entry is informational and the claims stay active.
			if (cfg.requireReview) {
				await db.update(claims).set({ status: 'conflicted' }).where(inArray(claims.id, [claimId, cand.id]));
			}
			conflicts++;
		}
	}
	return { conflicts };
}
