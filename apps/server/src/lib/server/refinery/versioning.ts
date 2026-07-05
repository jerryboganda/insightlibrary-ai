/**
 * Topic version snapshots — the shared owner of topic_versions writes. Both the
 * correlation engine (incremental per-document updates) and the synthesis
 * composer call snapshotTopic() so history is consistent.
 */
import { eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { topics, topicVersions } from '../db/schema';

export interface SnapshotOpts {
	changelog?: { type: string; text: string; details: string }[];
	pageMd?: string;
	faithfulness?: number | null;
	createdBy?: string;
}

export async function snapshotTopic(topicId: string, opts: SnapshotOpts = {}): Promise<number | null> {
	const db = getDb();
	if (!db) return null;
	const [t] = await db.select().from(topics).where(eq(topics.id, topicId));
	if (!t) return null;

	const maxRes = await db.execute<{ max: number }>(
		sql`SELECT COALESCE(MAX(version), 0) AS max FROM topic_versions WHERE topic_id = ${topicId}`
	);
	const version = Number(maxRes.rows[0]?.max ?? 0) + 1;

	await db
		.insert(topicVersions)
		.values({
			id: `tv_${topicId}_${version}`,
			topicId,
			orgId: t.orgId,
			version,
			pageMd: opts.pageMd ?? '',
			sectionsSnapshot: (t.sections as unknown[]) ?? [],
			changelog: opts.changelog ?? [],
			faithfulness: opts.faithfulness ?? null,
			createdBy: opts.createdBy ?? 'system'
		})
		.onConflictDoNothing();
	return version;
}
