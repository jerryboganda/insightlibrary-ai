import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { webhooks } from '$lib/server/db/schema';
import { requireRole } from '$lib/server/auth-guard';

/**
 * PATCH /api/webhooks/[id] { url?, event?, active? } — edit an endpoint or
 * toggle it on/off (gap B3: Active/Inactive used to be untoggleable).
 */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	requireRole(locals.user, 'admin');
	const db = getDb();
	if (!db) throw error(503, 'A database is required');
	const body = (await request.json().catch(() => ({}))) as {
		url?: string;
		event?: string;
		active?: boolean;
	};

	const patch: Partial<typeof webhooks.$inferInsert> = {};
	if (body.url !== undefined) {
		try {
			const parsed = new URL(body.url);
			if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol');
		} catch {
			throw error(400, 'url must be a valid http(s) URL');
		}
		patch.url = body.url;
	}
	if (body.event !== undefined) patch.event = body.event.trim() || '*';
	if (body.active !== undefined) patch.active = Boolean(body.active);
	if (!Object.keys(patch).length) throw error(400, 'Nothing to update (url, event, active)');

	const [row] = await db
		.update(webhooks)
		.set(patch)
		.where(and(eq(webhooks.id, params.id), eq(webhooks.orgId, locals.user?.orgId || 'org_1')))
		.returning();
	if (!row) throw error(404, 'Webhook not found');

	// Delivery bookkeeping columns (0011) are read best-effort.
	let lastDeliveryAt: string | null = null;
	let lastStatus: string | null = null;
	let secretSet = false;
	try {
		const res = await db.execute<{
			secret: string | null;
			last_delivery_at: Date | string | null;
			last_status: string | null;
		}>(sql`SELECT secret, last_delivery_at, last_status FROM webhooks WHERE id = ${params.id}`);
		const extra = res.rows[0];
		if (extra) {
			secretSet = Boolean(extra.secret);
			lastDeliveryAt = extra.last_delivery_at ? new Date(extra.last_delivery_at).toISOString() : null;
			lastStatus = extra.last_status ?? null;
		}
	} catch {
		/* pre-0011 deployment */
	}

	return json({
		id: row.id,
		url: row.url,
		event: row.event,
		active: row.active,
		createdAt: row.createdAt.toISOString(),
		secretSet,
		lastDeliveryAt,
		lastStatus
	});
};

/** DELETE /api/webhooks/[id] — remove a webhook endpoint. */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireRole(locals.user, 'admin');
	const db = getDb();
	if (db) {
		await db.delete(webhooks).where(and(eq(webhooks.id, params.id), eq(webhooks.orgId, locals.user?.orgId || 'org_1')));
	}
	return json({ ok: true });
};
