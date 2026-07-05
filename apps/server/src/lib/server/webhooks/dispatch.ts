/**
 * Webhook dispatcher (gap B3) — makes registered endpoints actually fire.
 *
 * dispatchWebhooks(orgId, event, payload) loads the org's active webhooks whose
 * event pattern matches, POSTs a JSON envelope to each with a ~5s timeout, and
 * records the delivery result (last_delivery_at / last_status, migration 0011).
 * When the endpoint has a stored secret (generated at registration) the body is
 * signed with HMAC-SHA256 in the `x-insight-signature` header.
 *
 * Fire-and-forget by design: this module NEVER throws — a webhook consumer
 * being down must not break ingestion, conflict detection, or review flows.
 * Worker-safe (getDb()/process.env only; global fetch).
 */
import { createHmac, randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { webhooks } from '../db/schema';

/** Events currently emitted by the platform (also drives the UI's selector). */
export const WEBHOOK_EVENTS = [
	'document.indexed',
	'document.failed',
	'conflict.detected',
	'review.resolved'
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number] | 'webhook.test';

export interface WebhookEndpoint {
	id: string;
	url: string;
	event: string;
	/** null when the secret column is not migrated yet or no secret was minted. */
	secret: string | null;
}

export interface DeliveryResult {
	webhookId: string;
	url: string;
	ok: boolean;
	/** HTTP status code, or 0 for transport-level failures (timeout, DNS, …). */
	status: number;
	/** last_status text persisted on the row, e.g. '200' or 'error: timeout'. */
	statusText: string;
	durationMs: number;
	error?: string;
}

const DELIVERY_TIMEOUT_MS = 5_000;

/** Generate a new endpoint signing secret (one-time reveal at registration). */
export function generateWebhookSecret(): string {
	return `whsec_${randomBytes(24).toString('base64url')}`;
}

/**
 * Pattern match: '*' matches everything, 'document.*' matches the category,
 * otherwise exact. Empty pattern behaves like '*' (legacy rows default to '*').
 */
export function matchesEvent(pattern: string, event: string): boolean {
	const p = (pattern || '*').trim();
	if (p === '*' || p === event) return true;
	if (p.endsWith('.*')) return event.startsWith(p.slice(0, -1));
	return false;
}

/** Compute the signature header value for a serialized payload. */
export function signPayload(secret: string, body: string): string {
	return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** Load active org webhooks matching an event. Tolerates a missing secret column. */
export async function loadMatchingWebhooks(orgId: string, event: string): Promise<WebhookEndpoint[]> {
	const db = getDb();
	if (!db) return [];
	let rows: WebhookEndpoint[] = [];
	try {
		const res = await db.execute<{ id: string; url: string; event: string; secret: string | null }>(
			sql`SELECT id, url, event, secret FROM webhooks WHERE org_id = ${orgId} AND active = true`
		);
		rows = res.rows.map((r) => ({ id: r.id, url: r.url, event: r.event, secret: r.secret ?? null }));
	} catch {
		// secret column not migrated yet (0011) — plain unsigned POSTs.
		const res = await db
			.select()
			.from(webhooks)
			.where(and(eq(webhooks.orgId, orgId), eq(webhooks.active, true)))
			.catch(() => []);
		rows = res.map((r) => ({ id: r.id, url: r.url, event: r.event, secret: null }));
	}
	return rows.filter((r) => matchesEvent(r.event, event));
}

/** Best-effort delivery bookkeeping (columns added in 0011; absence tolerated). */
async function recordDelivery(webhookId: string, statusText: string): Promise<void> {
	const db = getDb();
	if (!db) return;
	await db
		.execute(
			sql`UPDATE webhooks SET last_delivery_at = now(), last_status = ${statusText} WHERE id = ${webhookId}`
		)
		.catch(() => {});
}

/**
 * Deliver one event to one endpoint. Never throws; the result carries the
 * outcome (also persisted onto the webhook row for the integrations UI).
 */
export async function deliverToWebhook(
	hook: WebhookEndpoint,
	orgId: string,
	event: string,
	payload: Record<string, unknown>
): Promise<DeliveryResult> {
	const startedAt = Date.now();
	const envelope = {
		event,
		orgId,
		webhookId: hook.id,
		timestamp: new Date().toISOString(),
		data: payload
	};
	const body = JSON.stringify(envelope);

	const base: Omit<DeliveryResult, 'ok' | 'status' | 'statusText' | 'durationMs' | 'error'> = {
		webhookId: hook.id,
		url: hook.url
	};

	// Refuse obviously invalid targets without attempting a request.
	let parsed: URL;
	try {
		parsed = new URL(hook.url);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported protocol');
	} catch {
		const statusText = 'error: invalid url';
		await recordDelivery(hook.id, statusText);
		return { ...base, ok: false, status: 0, statusText, durationMs: 0, error: 'Invalid webhook URL' };
	}

	const headers: Record<string, string> = {
		'content-type': 'application/json',
		'user-agent': 'InsightLibrary-Webhooks/1.0',
		'x-insight-event': event,
		'x-insight-delivery': `whd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
	};
	if (hook.secret) headers['x-insight-signature'] = signPayload(hook.secret, body);

	try {
		const res = await fetch(hook.url, {
			method: 'POST',
			headers,
			body,
			signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
			redirect: 'error'
		});
		const statusText = String(res.status);
		await recordDelivery(hook.id, statusText);
		return {
			...base,
			ok: res.ok,
			status: res.status,
			statusText,
			durationMs: Date.now() - startedAt
		};
	} catch (e) {
		const msg =
			e instanceof Error && e.name === 'TimeoutError'
				? 'timeout'
				: e instanceof Error
					? e.message.slice(0, 120)
					: String(e).slice(0, 120);
		const statusText = `error: ${msg}`;
		await recordDelivery(hook.id, statusText);
		return {
			...base,
			ok: false,
			status: 0,
			statusText,
			durationMs: Date.now() - startedAt,
			error: msg
		};
	}
}

/**
 * Fan an event out to every matching active webhook of the org. Deliveries run
 * in parallel; failures are logged and recorded, never thrown. Returns the
 * per-endpoint results (callers may ignore them).
 */
export async function dispatchWebhooks(
	orgId: string,
	event: string,
	payload: Record<string, unknown>
): Promise<DeliveryResult[]> {
	try {
		const hooks = await loadMatchingWebhooks(orgId, event);
		if (!hooks.length) return [];
		const results = await Promise.all(hooks.map((h) => deliverToWebhook(h, orgId, event, payload)));
		for (const r of results) {
			if (!r.ok) console.error(`[webhooks] delivery failed (${event} → ${r.url}): ${r.statusText}`);
		}
		return results;
	} catch (e) {
		console.error('[webhooks] dispatch failed:', e instanceof Error ? e.message : e);
		return [];
	}
}
