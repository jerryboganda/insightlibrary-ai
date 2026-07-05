import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { apiKeys } from '$lib/server/db/schema';
import { requireRole } from '$lib/server/auth-guard';

/** DELETE /api/api-keys/[id] — revoke a key. */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireRole(locals.user, 'admin');
	const db = getDb();
	if (db) {
		await db.delete(apiKeys).where(and(eq(apiKeys.id, params.id), eq(apiKeys.orgId, locals.user?.orgId || 'org_1')));
	}
	return json({ ok: true });
};
