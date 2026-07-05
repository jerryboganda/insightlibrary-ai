import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { desc, eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { topicVersions } from '$lib/server/db/schema';

/** GET /api/topics/[id]/versions — version history for the SSOT version tab. */
export const GET: RequestHandler = async ({ params }) => {
	const db = getDb();
	if (!db) return json({ items: [], total: 0 });
	const rows = await db
		.select()
		.from(topicVersions)
		.where(eq(topicVersions.topicId, params.id))
		.orderBy(desc(topicVersions.version));
	const items = rows.map((r) => ({
		id: r.id,
		topicId: r.topicId,
		version: r.version,
		pageMd: r.pageMd,
		changelog: r.changelog,
		faithfulness: r.faithfulness,
		createdBy: r.createdBy,
		createdAt: r.createdAt.toISOString()
	}));
	return json({ items, total: items.length });
};
