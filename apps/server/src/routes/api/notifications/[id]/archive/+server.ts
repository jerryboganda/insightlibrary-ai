import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { notifications } from '$lib/server/db/schema';

/** POST /api/notifications/[id]/archive — mark a single notification read/archived. */
export const POST: RequestHandler = async ({ params, locals }) => {
	const db = getDb();
	if (db) {
		await db
			.update(notifications)
			.set({ read: true })
			.where(and(eq(notifications.id, params.id), eq(notifications.orgId, locals.user?.orgId || 'org_1')));
	}
	return json({ ok: true });
};
