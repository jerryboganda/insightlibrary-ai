import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { webhooks } from '$lib/server/db/schema';
import { requireRole } from '$lib/server/auth-guard';

/** DELETE /api/webhooks/[id] — remove a webhook endpoint. */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireRole(locals.user, 'admin');
	const db = getDb();
	if (db) {
		await db.delete(webhooks).where(and(eq(webhooks.id, params.id), eq(webhooks.orgId, locals.user?.orgId || 'org_1')));
	}
	return json({ ok: true });
};
