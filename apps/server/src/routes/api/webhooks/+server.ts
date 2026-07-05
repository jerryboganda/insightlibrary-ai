import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { desc, eq, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { webhooks } from '$lib/server/db/schema';
import { requireRole } from '$lib/server/auth-guard';
import { generateWebhookSecret, WEBHOOK_EVENTS } from '$lib/server/webhooks/dispatch';

export interface WebhookListItem {
	id: string;
	url: string;
	event: string;
	active: boolean;
	createdAt: string | null;
	/** True when an HMAC signing secret exists (the secret itself is never re-shown). */
	secretSet: boolean;
	lastDeliveryAt: string | null;
	/** '200' | '503' | 'error: timeout' | null when never delivered. */
	lastStatus: string | null;
}

/** GET /api/webhooks — list org webhook endpoints incl. last delivery result. */
export const GET: RequestHandler = async ({ locals }) => {
	const db = getDb();
	if (!db) return json({ items: [], total: 0, events: WEBHOOK_EVENTS });
	const orgId = locals.user?.orgId || 'org_1';
	let items: WebhookListItem[];
	try {
		const res = await db.execute<{
			id: string;
			url: string;
			event: string;
			active: boolean;
			created_at: Date | string | null;
			secret: string | null;
			last_delivery_at: Date | string | null;
			last_status: string | null;
		}>(sql`
			SELECT id, url, event, active, created_at, secret, last_delivery_at, last_status
			FROM webhooks WHERE org_id = ${orgId} ORDER BY created_at DESC
		`);
		items = res.rows.map((r) => ({
			id: r.id,
			url: r.url,
			event: r.event,
			active: r.active,
			createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
			secretSet: Boolean(r.secret),
			lastDeliveryAt: r.last_delivery_at ? new Date(r.last_delivery_at).toISOString() : null,
			lastStatus: r.last_status ?? null
		}));
	} catch {
		// 0011 columns not migrated yet — serve the base shape.
		const rows = await db
			.select()
			.from(webhooks)
			.where(eq(webhooks.orgId, orgId))
			.orderBy(desc(webhooks.createdAt));
		items = rows.map((r) => ({
			id: r.id,
			url: r.url,
			event: r.event,
			active: r.active,
			createdAt: r.createdAt.toISOString(),
			secretSet: false,
			lastDeliveryAt: null,
			lastStatus: null
		}));
	}
	return json({ items, total: items.length, events: WEBHOOK_EVENTS });
};

/**
 * POST /api/webhooks { url, event? } — register a webhook endpoint. Mints an
 * HMAC signing secret returned ONCE in this response (stored server-side,
 * never re-shown; deliveries carry x-insight-signature computed with it).
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireRole(locals.user, 'admin');
	const db = getDb();
	if (!db) throw error(503, 'A database is required');
	const body = (await request.json().catch(() => ({}))) as { url?: string; event?: string };
	if (!body.url) throw error(400, 'url required');
	try {
		const parsed = new URL(body.url);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol');
	} catch {
		throw error(400, 'url must be a valid http(s) URL');
	}
	const event = body.event?.trim() || '*';
	const id = `wh_${Date.now()}`;
	const orgId = locals.user?.orgId || 'org_1';
	const secret = generateWebhookSecret();
	let secretStored = true;
	try {
		await db.execute(sql`
			INSERT INTO webhooks (id, org_id, url, event, active, secret)
			VALUES (${id}, ${orgId}, ${body.url}, ${event}, true, ${secret})
		`);
	} catch {
		// secret column not migrated yet (0011) — register unsigned.
		secretStored = false;
		await db.insert(webhooks).values({ id, orgId, url: body.url, event });
	}
	return json({
		id,
		url: body.url,
		event,
		active: true,
		// One-time reveal; null when the deployment cannot sign yet.
		secret: secretStored ? secret : null,
		signing: secretStored
			? 'Deliveries are signed: x-insight-signature = sha256=HMAC_SHA256(secret, body)'
			: 'Signing unavailable until migration 0011 is applied — deliveries are plain POSTs'
	});
};
