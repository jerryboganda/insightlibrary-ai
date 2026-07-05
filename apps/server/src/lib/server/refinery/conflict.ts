/**
 * Conflict detection: same-subject claims that contradict are flagged (status
 * 'conflicted'), both kept, and surfaced in the existing human review queue
 * (review_items) rather than silently resolved.
 *
 * This module also owns the other half of that contract (gap B21):
 * resolveClaimConflict() is called by POST /api/review/[id] when a human
 * decides the queue item, and settles the two claims —
 *   accepted → the incoming claim becomes active, the original is superseded
 *              (supersedes_claim_id on the loser points at the winner, the
 *              same convention dedup.ts uses);
 *   rejected → the original claim is restored to active, the incoming claim
 *              is retired.
 * Either way no claim is left frozen on 'conflicted'.
 *
 * New detections emit a human notification + a 'conflict.detected' webhook
 * (gaps B20/B3), deduplicated per review item so re-correlation passes do not
 * spam. Worker-safe (getDb()/process.env only).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb, type Db } from '../db/client';
import { claims, reviewItems, topics } from '../db/schema';
import { getRefineryConfig } from './config';
import { classifyPair } from './nli';
import { dispatchWebhooks } from '../webhooks/dispatch';
import { notify } from '../webhooks/notify';

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
			const itemId = `ri_${claimId}_${cand.id}`;
			const inserted = await db
				.insert(reviewItems)
				.values({
					id: itemId,
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
				.onConflictDoNothing()
				.returning({ id: reviewItems.id });
			const isNew = inserted.length > 0;

			if (!isNew) {
				// The pair was queued before. If a human already resolved it, this
				// re-detection must not re-freeze the claims or re-notify.
				const [existing] = await db
					.select({ status: reviewItems.status })
					.from(reviewItems)
					.where(eq(reviewItems.id, itemId));
				if (existing && existing.status !== 'pending') continue;
			}

			// Link the two conflicted claim rows onto the queue item (0011 columns)
			// so resolution can settle exactly these rows. Best-effort — legacy
			// deployments without the columns fall back to text matching.
			await db
				.execute(
					sql`UPDATE review_items SET original_claim_id = ${cand.id}, new_claim_id = ${claimId} WHERE id = ${itemId}`
				)
				.catch(() => {});

			// Governance "require review": when enabled (default) both claims are
			// frozen as 'conflicted' until a human resolves the queue item; when
			// disabled the queue entry is informational and the claims stay active.
			if (cfg.requireReview) {
				await db.update(claims).set({ status: 'conflicted' }).where(inArray(claims.id, [claimId, cand.id]));
			}
			conflicts++;

			if (isNew) {
				// Human + machine fan-out, deduped per review item. Never blocks.
				let topicName = '';
				if (c.topicId) {
					const [t] = await db
						.select({ name: topics.name })
						.from(topics)
						.where(eq(topics.id, c.topicId))
						.catch(() => [] as { name: string }[]);
					topicName = t?.name ?? '';
				}
				notify(orgId, {
					type: 'conflict',
					title: 'Contradiction detected',
					description:
						(topicName ? `${topicName}: ` : '') +
						`"${c.claimText.slice(0, 110)}" contradicts "${cand.claim_text.slice(0, 110)}"` +
						(cfg.requireReview ? ' — review required.' : ' — informational (review not required).'),
					action: '/review',
					dedupeKey: itemId
				});
				void dispatchWebhooks(orgId, 'conflict.detected', {
					reviewItemId: itemId,
					topicId: c.topicId ?? null,
					topic: topicName || null,
					newClaimId: claimId,
					newClaim: c.claimText,
					originalClaimId: cand.id,
					originalClaim: cand.claim_text,
					confidence: rel.confidence ?? 0.5,
					requiresReview: cfg.requireReview
				}).catch(() => {});
			}
		}
	}
	return { conflicts };
}

// ── Resolution (gap B21) ─────────────────────────────────────────────────────

export interface ConflictResolution {
	/** True when at least one underlying claim row was settled. */
	resolved: boolean;
	winnerClaimId: string | null;
	loserClaimId: string | null;
	detail: string;
}

// Type alias (not interface) so it satisfies db.execute's Record constraint.
type ReviewItemRow = {
	type: string;
	original_claim: string | null;
	new_claim: string;
	source_a: string | null;
	source_b: string;
	original_claim_id: string | null;
	new_claim_id: string | null;
};

/** Find a claim row by exact text, preferring the expected source document. */
async function findClaimByText(
	db: Db,
	orgId: string,
	text: string | null,
	documentId: string | null
): Promise<string | null> {
	if (!text) return null;
	const res = await db.execute<{ id: string }>(sql`
		SELECT id FROM claims
		WHERE org_id = ${orgId} AND claim_text = ${text}
		ORDER BY (document_id IS NOT DISTINCT FROM ${documentId}) DESC, created_at DESC
		LIMIT 1
	`);
	return res.rows[0]?.id ?? null;
}

/**
 * Settle the two claims behind a decided review item. Idempotent and
 * best-effort: legacy items without claim linkage fall back to exact-text
 * matching; when neither claim can be located the review decision still
 * stands and the caller gets resolved=false with a reason.
 */
export async function resolveClaimConflict(
	reviewItemId: string,
	decision: 'accepted' | 'rejected',
	orgId: string
): Promise<ConflictResolution> {
	const db = getDb();
	if (!db) return { resolved: false, winnerClaimId: null, loserClaimId: null, detail: 'No database — nothing to settle' };

	let item: ReviewItemRow | undefined;
	try {
		const res = await db.execute<ReviewItemRow>(sql`
			SELECT type, original_claim, new_claim, source_a, source_b, original_claim_id, new_claim_id
			FROM review_items WHERE id = ${reviewItemId} AND org_id = ${orgId}
		`);
		item = res.rows[0];
	} catch {
		// 0011 claim-id columns not migrated yet.
		const res = await db.execute<Omit<ReviewItemRow, 'original_claim_id' | 'new_claim_id'>>(sql`
			SELECT type, original_claim, new_claim, source_a, source_b
			FROM review_items WHERE id = ${reviewItemId} AND org_id = ${orgId}
		`);
		item = res.rows[0] ? { ...res.rows[0], original_claim_id: null, new_claim_id: null } : undefined;
	}
	if (!item) return { resolved: false, winnerClaimId: null, loserClaimId: null, detail: 'Review item not found' };
	if (item.type !== 'conflict') {
		return { resolved: false, winnerClaimId: null, loserClaimId: null, detail: `No claim conflict behind a '${item.type}' item` };
	}

	const originalId =
		item.original_claim_id ?? (await findClaimByText(db, orgId, item.original_claim, item.source_a));
	const newId = item.new_claim_id ?? (await findClaimByText(db, orgId, item.new_claim, item.source_b));
	if (!originalId && !newId) {
		return { resolved: false, winnerClaimId: null, loserClaimId: null, detail: 'Underlying claims not found (legacy item)' };
	}

	// Mark the moment of human resolution (0011 column; best-effort).
	await db.execute(sql`UPDATE review_items SET resolved_at = now() WHERE id = ${reviewItemId}`).catch(() => {});

	const now = new Date();
	if (decision === 'accepted') {
		// Incoming claim wins: unfreeze it to active; the original is superseded,
		// its supersedes_claim_id pointing at the winner (dedup.ts convention).
		if (newId) {
			await db.update(claims).set({ status: 'active', updatedAt: now }).where(and(eq(claims.id, newId), eq(claims.orgId, orgId)));
		}
		if (originalId) {
			await db
				.update(claims)
				.set({ status: 'superseded', supersedesClaimId: newId, updatedAt: now })
				.where(and(eq(claims.id, originalId), eq(claims.orgId, orgId)));
		}
		return {
			resolved: true,
			winnerClaimId: newId,
			loserClaimId: originalId,
			detail: 'New claim accepted as active; original claim superseded'
		};
	}

	// Rejected: the original claim is restored to active; the incoming claim is
	// retired (kept for provenance, excluded from active reasoning).
	if (originalId) {
		await db.update(claims).set({ status: 'active', updatedAt: now }).where(and(eq(claims.id, originalId), eq(claims.orgId, orgId)));
	}
	if (newId) {
		await db.update(claims).set({ status: 'retired', updatedAt: now }).where(and(eq(claims.id, newId), eq(claims.orgId, orgId)));
	}
	return {
		resolved: true,
		winnerClaimId: originalId,
		loserClaimId: newId,
		detail: 'Original claim restored to active; new claim retired'
	};
}
