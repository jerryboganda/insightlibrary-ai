import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { notifications } from '$lib/server/db/schema';

/**
 * PATCH /api/notifications/[id] { read?, archived? } — persist per-item
 * notification state server-side (gap B29). `read` covers the bell/feed
 * mark-as-read toggle without archiving; `archived` hides the row from the
 * default feed (same effect as POST /api/notifications/[id]/archive).
 */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	const db = getDb();
	if (!db) throw error(503, 'A database is required');
	const body = (await request.json().catch(() => ({}))) as { read?: boolean; archived?: boolean };
	if (typeof body.read !== 'boolean' && typeof body.archived !== 'boolean') {
		throw error(400, 'Nothing to update (read, archived)');
	}
	const orgId = locals.user?.orgId || 'org_1';

	// Existence check (org-scoped) so callers get an honest 404.
	const [existing] = await db
		.select({ id: notifications.id, read: notifications.read })
		.from(notifications)
		.where(and(eq(notifications.id, params.id), eq(notifications.orgId, orgId)));
	if (!existing) throw error(404, 'Notification not found');

	const read = typeof body.read === 'boolean' ? body.read : existing.read;
	let archivedPersisted = true;
	if (typeof body.archived === 'boolean') {
		try {
			await db.execute(
				sql`UPDATE notifications SET read = ${read}, archived = ${body.archived} WHERE id = ${params.id} AND org_id = ${orgId}`
			);
		} catch {
			// archived column not migrated yet (0011) — persist what we can.
			archivedPersisted = false;
			await db
				.update(notifications)
				.set({ read })
				.where(and(eq(notifications.id, params.id), eq(notifications.orgId, orgId)));
		}
	} else {
		await db
			.update(notifications)
			.set({ read })
			.where(and(eq(notifications.id, params.id), eq(notifications.orgId, orgId)));
	}

	return json({
		ok: true,
		id: params.id,
		read,
		...(typeof body.archived === 'boolean' ? { archived: body.archived, archivedPersisted } : {})
	});
};
