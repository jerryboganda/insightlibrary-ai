import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { desc, eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { webhooks } from '$lib/server/db/schema';
import { requireRole } from '$lib/server/auth-guard';

/** GET /api/webhooks — list org webhook endpoints. */
export const GET: RequestHandler = async ({ locals }) => {
	const db = getDb();
	if (!db) return json({ items: [], total: 0 });
	const rows = await db
		.select()
		.from(webhooks)
		.where(eq(webhooks.orgId, locals.user?.orgId || 'org_1'))
		.orderBy(desc(webhooks.createdAt));
	return json({ items: rows.map((r) => ({ id: r.id, url: r.url, event: r.event, active: r.active })), total: rows.length });
};

/** POST /api/webhooks { url, event? } — register a webhook endpoint. */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireRole(locals.user, 'admin');
	const db = getDb();
	if (!db) throw error(503, 'A database is required');
	const body = (await request.json().catch(() => ({}))) as { url?: string; event?: string };
	if (!body.url) throw error(400, 'url required');
	const id = `wh_${Date.now()}`;
	await db.insert(webhooks).values({ id, orgId: locals.user?.orgId || 'org_1', url: body.url, event: body.event ?? '*' });
	return json({ id, url: body.url, event: body.event ?? '*', active: true });
};
