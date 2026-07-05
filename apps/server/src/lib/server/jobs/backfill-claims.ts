/**
 * One-time backfill: parse every topics.sections JSONB claim into the normalized
 * claims + claim_sources tables. Idempotent (onConflictDoNothing). Run once after
 * `db:migrate` via `tsx src/lib/server/jobs/backfill-claims.ts`. Worker-safe
 * (process.env only).
 */
import { getDb } from '../db/client';
import { claims, claimSources, topics } from '../db/schema';
import { embedText } from '../ai/embeddings';

type JsonbClaim = { id: string; content: string; citations: string[] };
type JsonbSection = { id: string; claims: JsonbClaim[] };

async function main() {
	const db = getDb();
	if (!db) {
		console.error('DATABASE_URL not set — nothing to backfill.');
		process.exit(1);
	}
	const allTopics = await db.select().from(topics);
	let claimCount = 0;
	let srcCount = 0;

	for (const t of allTopics) {
		const sections = (t.sections as JsonbSection[]) ?? [];
		for (const section of sections) {
			for (const claim of section.claims ?? []) {
				const claimRowId = `nc_${t.id}_${section.id}_${claim.id}`;
				const embedding = await embedText(claim.content).catch(() => null);
				await db
					.insert(claims)
					.values({
						id: claimRowId,
						orgId: t.orgId,
						topicId: t.id,
						sectionId: section.id,
						jsonbClaimId: claim.id,
						claimType: 'fact',
						claimText: claim.content,
						normalizedMeaning: embedding,
						status: 'active'
					})
					.onConflictDoNothing();
				claimCount++;

				const rows: (typeof claimSources.$inferInsert)[] = [];
				const cits = claim.citations ?? [];
				for (let i = 0; i < cits.length; i += 2) {
					const sourceRef = cits[i];
					const locator = cits[i + 1] ?? null;
					if (!sourceRef) continue;
					rows.push({ id: `cs_${claimRowId}_${i}`, claimId: claimRowId, sourceRef, locator, stance: 'supports' });
				}
				if (rows.length) {
					await db.insert(claimSources).values(rows).onConflictDoNothing();
					srcCount += rows.length;
				}
			}
		}
	}
	console.log(`Backfilled ${claimCount} claims and ${srcCount} sources from ${allTopics.length} topics.`);
	process.exit(0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
