/**
 * Topic version snapshots — the shared owner of topic_versions writes. Both the
 * correlation engine (incremental per-document updates) and the synthesis
 * composer call snapshotTopic() so history is consistent. Restores also live
 * here (A1): a restore writes an old snapshot back to the live topic and then
 * snapshots THAT as a new version, keeping history strictly append-only.
 */
import { and, eq, sql } from 'drizzle-orm';
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

export interface RestoreResult {
	ok: boolean;
	reason?: string;
	/** The historical version whose snapshot was written back. */
	restoredFrom?: number;
	/** The NEW version created to record the restore (history stays append-only). */
	version?: number | null;
	faithfulness?: number | null;
}

/**
 * Write a historical snapshot back to topics.sections and record the restore
 * as a fresh topic_version. Never deletes or rewrites existing versions.
 */
export async function restoreTopicVersion(
	topicId: string,
	version: number,
	opts: { createdBy?: string } = {}
): Promise<RestoreResult> {
	const db = getDb();
	if (!db) return { ok: false, reason: 'no database' };

	const [t] = await db.select().from(topics).where(eq(topics.id, topicId));
	if (!t) return { ok: false, reason: 'topic not found' };

	const [v] = await db
		.select()
		.from(topicVersions)
		.where(and(eq(topicVersions.topicId, topicId), eq(topicVersions.version, version)));
	if (!v) return { ok: false, reason: `version ${version} not found for this topic` };

	const sections = (v.sectionsSnapshot as unknown[]) ?? [];
	await db
		.update(topics)
		.set({
			sections,
			updatedAt: new Date(),
			updates: sql`${topics.updates} + 1`,
			// Compose sets health from faithfulness; keep the restored page consistent.
			...(v.faithfulness != null ? { health: Math.round(v.faithfulness * 100) } : {})
		})
		.where(eq(topics.id, topicId));

	const newVersion = await snapshotTopic(topicId, {
		changelog: [
			{
				type: 'restore',
				text: `Restored SSOT from version ${version}`,
				details: `Snapshot of v${version} (${sections.length} sections) written back to the live topic`
			}
		],
		pageMd: v.pageMd ?? '',
		faithfulness: v.faithfulness ?? null,
		createdBy: opts.createdBy ?? 'system'
	}).catch(() => null);

	return { ok: true, restoredFrom: version, version: newVersion, faithfulness: v.faithfulness ?? null };
}
