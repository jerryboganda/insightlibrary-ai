import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { notifications } from '$lib/server/db/schema';

/**
 * POST /api/notifications/[id]/archive — persist per-item state (gap B29):
 * marks the notification read AND archived (0011 column), removing it from the
 * default feed. Pre-migration deployments degrade to read-only marking.
 * For a non-archiving read toggle use PATCH /api/notifications/[id].
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	const db = getDb();
	if (!db) return json({ ok: true, archived: false });
	const orgId = locals.user?.orgId || 'org_1';
	let archived = true;
	try {
		await db.execute(
			sql`UPDATE notifications SET read = true, archived = true WHERE id = ${params.id} AND org_id = ${orgId}`
		);
	} catch {
		// archived column not migrated yet (0011) — at least persist the read flag.
		archived = false;
		await db
			.update(notifications)
			.set({ read: true })
			.where(and(eq(notifications.id, params.id), eq(notifications.orgId, orgId)));
	}
	return json({ ok: true, archived });
};
