/**
 * Evidence retrieval for synthesis — gathers a topic's first-class claims with
 * their provenance (as interleaved [sourceRef, locator, …] citation tokens,
 * matching the JSONB SSOT convention) plus the topic's ontology aliases for the
 * recall audit.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db/client';
import { claims, claimSources, topics } from '../db/schema';
import { expandAliases } from '../ontology/link';

export interface ClaimEvidence {
	id: string;
	text: string;
	type: string;
	/** Interleaved [sourceRef, locator, sourceRef, locator, …]. */
	citations: string[];
}

export async function retrieveTopicEvidence(
	topicId: string
): Promise<{ topicName: string; aliases: string[]; evidence: ClaimEvidence[] }> {
	const db = getDb();
	if (!db) return { topicName: '', aliases: [], evidence: [] };
	const [t] = await db.select().from(topics).where(eq(topics.id, topicId));
	if (!t) return { topicName: '', aliases: [], evidence: [] };

	const claimRows = await db
		.select()
		.from(claims)
		.where(and(eq(claims.topicId, topicId), inArray(claims.status, ['active', 'conflicted'])));

	const evidence: ClaimEvidence[] = [];
	for (const c of claimRows) {
		const srcs = await db.select().from(claimSources).where(eq(claimSources.claimId, c.id));
		const citations: string[] = [];
		for (const s of srcs) {
			citations.push(s.sourceRef ?? s.documentId ?? 'src');
			citations.push(s.locator ?? '');
		}
		evidence.push({ id: c.id, text: c.claimText, type: c.claimType, citations: citations.length ? citations : ['uncited', ''] });
	}

	const aliases = await expandAliases(t.name).catch(() => [t.name]);
	return { topicName: t.name, aliases, evidence };
}
