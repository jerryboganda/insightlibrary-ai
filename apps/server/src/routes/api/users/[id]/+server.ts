import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { users } from '$lib/server/db/schema';
import { requireRole } from '$lib/server/auth-guard';

/** PATCH /api/users/[id] { role?, status? } — update a user's role/status (admin). */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	requireRole(locals.user, 'admin');
	const db = getDb();
	if (!db) throw error(503, 'A database is required');
	const body = (await request.json().catch(() => ({}))) as { role?: string; status?: string };
	const set: Partial<{ role: string; status: string }> = {};
	if (body.role && ['owner', 'admin', 'editor', 'viewer'].includes(body.role)) set.role = body.role;
	if (body.status && ['active', 'suspended'].includes(body.status)) set.status = body.status;
	if (!Object.keys(set).length) throw error(400, 'nothing to update');
	const [r] = await db
		.update(users)
		.set(set)
		.where(and(eq(users.id, params.id), eq(users.orgId, locals.user?.orgId || 'org_1')))
		.returning();
	if (!r) throw error(404, 'user not found');
	return json({ id: r.id, role: r.role, status: r.status });
};
