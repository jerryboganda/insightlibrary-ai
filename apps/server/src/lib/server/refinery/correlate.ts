/**
 * Correlation orchestrator — runs after claim extraction for a document:
 * dedup → conflict → graph triples → incremental topic version snapshots.
 * Everything is best-effort and no-ops without a DB / provider.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { claims } from '../db/schema';
import { REFINERY_CONFIG } from './config';
import { dedupClaim } from './dedup';
import { detectConflictsForClaim } from './conflict';
import { extractTriplesForDocument } from './extract-triples';
import { snapshotTopic } from './versioning';

export async function correlateDocument(
	documentId: string,
	orgId = 'org_1'
): Promise<{ merged: number; conflicts: number; triples: number; versioned: number }> {
	const db = getDb();
	if (!db) return { merged: 0, conflicts: 0, triples: 0, versioned: 0 };

	const rows = await db
		.select()
		.from(claims)
		.where(and(eq(claims.documentId, documentId), eq(claims.orgId, orgId)));

	let merged = 0;
	let conflicts = 0;
	const topicsTouched = new Set<string>();

	for (const c of rows.slice(0, REFINERY_CONFIG.maxCorrelateClaims)) {
		if (c.topicId) topicsTouched.add(c.topicId);
		if (c.status !== 'active') continue;
		const d = await dedupClaim(c.id, orgId).catch(() => ({ merged: false }));
		if (d.merged) {
			merged++;
			continue; // superseded — don't also conflict-check it
		}
		const cf = await detectConflictsForClaim(c.id, orgId).catch(() => ({ conflicts: 0 }));
		conflicts += cf.conflicts;
	}

	const tri = await extractTriplesForDocument(documentId, orgId).catch(() => ({ triples: 0 }));

	let versioned = 0;
	for (const topicId of topicsTouched) {
		const v = await snapshotTopic(topicId, {
			changelog: [{ type: 'new', text: `Correlated document ${documentId}`, details: '' }]
		}).catch(() => null);
		if (v) versioned++;
	}

	return { merged, conflicts, triples: tri.triples, versioned };
}
