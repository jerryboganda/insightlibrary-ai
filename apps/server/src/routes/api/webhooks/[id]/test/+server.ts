import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { webhooks } from '$lib/server/db/schema';
import { requireRole } from '$lib/server/auth-guard';
import { deliverToWebhook, type WebhookEndpoint } from '$lib/server/webhooks/dispatch';

/**
 * POST /api/webhooks/[id]/test — send a real test delivery to this endpoint
 * (signed when a secret exists) and return the outcome. Works on inactive
 * endpoints too, so admins can verify a URL before enabling it. The result is
 * also persisted to last_delivery_at/last_status for the integrations list.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	requireRole(locals.user, 'admin');
	const db = getDb();
	if (!db) throw error(503, 'A database is required');
	const orgId = locals.user?.orgId || 'org_1';

	let hook: WebhookEndpoint | null = null;
	try {
		const res = await db.execute<{ id: string; url: string; event: string; secret: string | null }>(
			sql`SELECT id, url, event, secret FROM webhooks WHERE id = ${params.id} AND org_id = ${orgId}`
		);
		const r = res.rows[0];
		if (r) hook = { id: r.id, url: r.url, event: r.event, secret: r.secret ?? null };
	} catch {
		// secret column not migrated yet (0011) — unsigned test delivery.
		const [r] = await db
			.select()
			.from(webhooks)
			.where(and(eq(webhooks.id, params.id), eq(webhooks.orgId, orgId)));
		if (r) hook = { id: r.id, url: r.url, event: r.event, secret: null };
	}
	if (!hook) throw error(404, 'Webhook not found');

	const result = await deliverToWebhook(hook, orgId, 'webhook.test', {
		message: 'Test delivery from InsightLibrary',
		webhookId: hook.id,
		subscribedEvent: hook.event,
		triggeredBy: locals.user?.email ?? 'unknown'
	});

	return json({
		ok: result.ok,
		status: result.status,
		statusText: result.statusText,
		durationMs: result.durationMs,
		signed: Boolean(hook.secret),
		error: result.error ?? null
	});
};
