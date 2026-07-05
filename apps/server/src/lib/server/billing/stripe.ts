/**
 * Stripe billing (hosted-tier). Thin REST client via fetch (no SDK dep) behind
 * STRIPE_SECRET_KEY. Creates/looks up a per-org customer, opens Checkout for a
 * subscription (STRIPE_PRICE_ID), the Billing Portal for self-service, lists
 * invoices, and applies webhook events (signature-verified with node:crypto —
 * see verifyStripeSignature) to the `billing` row so paying actually upgrades
 * the org. No-ops with a clear 503 when unconfigured. Worker/route safe
 * (process.env).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { billing } from '../db/schema';

const STRIPE_BASE = 'https://api.stripe.com/v1';
const key = () => process.env.STRIPE_SECRET_KEY ?? null;
export const billingConfigured = () => !!key();
export const webhookConfigured = () => !!process.env.STRIPE_WEBHOOK_SECRET;

async function stripe<T>(path: string, params: Record<string, string>): Promise<T> {
	const k = key();
	if (!k) throw new Error('STRIPE_SECRET_KEY not set');
	const res = await fetch(`${STRIPE_BASE}${path}`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(params)
	});
	if (!res.ok) throw new Error(`stripe ${res.status}: ${(await res.text()).slice(0, 200)}`);
	return res.json() as Promise<T>;
}

async function stripeGet<T>(path: string): Promise<T> {
	const k = key();
	if (!k) throw new Error('STRIPE_SECRET_KEY not set');
	const res = await fetch(`${STRIPE_BASE}${path}`, { headers: { Authorization: `Bearer ${k}` } });
	if (!res.ok) throw new Error(`stripe ${res.status}: ${(await res.text()).slice(0, 200)}`);
	return res.json() as Promise<T>;
}

async function ensureCustomer(orgId: string, email?: string): Promise<string> {
	const db = getDb();
	if (!db) throw new Error('A database is required for billing');
	const [row] = await db.select().from(billing).where(eq(billing.orgId, orgId));
	if (row?.stripeCustomerId) return row.stripeCustomerId;
	const cust = await stripe<{ id: string }>('/customers', { 'metadata[orgId]': orgId, ...(email ? { email } : {}) });
	await db
		.insert(billing)
		.values({ orgId, stripeCustomerId: cust.id })
		.onConflictDoUpdate({ target: billing.orgId, set: { stripeCustomerId: cust.id, updatedAt: new Date() } });
	return cust.id;
}

export async function createCheckout(
	orgId: string,
	opts: { priceId?: string; successUrl: string; cancelUrl: string; email?: string }
): Promise<string> {
	const priceId = opts.priceId ?? process.env.STRIPE_PRICE_ID;
	if (!priceId) throw new Error('STRIPE_PRICE_ID not set');
	const customer = await ensureCustomer(orgId, opts.email);
	const s = await stripe<{ url: string }>('/checkout/sessions', {
		mode: 'subscription',
		customer,
		'line_items[0][price]': priceId,
		'line_items[0][quantity]': '1',
		success_url: opts.successUrl,
		cancel_url: opts.cancelUrl,
		// Stamp the org onto the session and the resulting subscription so the
		// webhook can resolve the org even if the billing row is ever lost.
		client_reference_id: orgId,
		'subscription_data[metadata][orgId]': orgId
	});
	return s.url;
}

export async function createPortal(orgId: string, returnUrl: string): Promise<string> {
	const customer = await ensureCustomer(orgId);
	const s = await stripe<{ url: string }>('/billing_portal/sessions', { customer, return_url: returnUrl });
	return s.url;
}

export async function getBillingStatus(orgId: string): Promise<{
	configured: boolean;
	plan: string;
	status: string;
	currentPeriodEnd: string | null;
	hasCustomer: boolean;
}> {
	const db = getDb();
	const row = db ? (await db.select().from(billing).where(eq(billing.orgId, orgId)))[0] : undefined;
	return {
		configured: billingConfigured(),
		plan: row?.plan ?? 'free',
		status: row?.status ?? 'inactive',
		currentPeriodEnd: row?.currentPeriodEnd?.toISOString() ?? null,
		hasCustomer: !!row?.stripeCustomerId
	};
}

// ── Invoices ─────────────────────────────────────────────────────────────────

export type BillingInvoice = {
	id: string;
	number: string | null;
	created: string;
	/** Total in the smallest currency unit (e.g. cents). */
	total: number;
	currency: string;
	status: string;
	hostedInvoiceUrl: string | null;
	invoicePdf: string | null;
};

type RawInvoice = {
	id: string;
	number?: string | null;
	created: number;
	total: number;
	currency: string;
	status?: string | null;
	hosted_invoice_url?: string | null;
	invoice_pdf?: string | null;
};

/** Real invoice history for the org's Stripe customer (empty when none exists). */
export async function listInvoices(orgId: string, limit = 12): Promise<BillingInvoice[]> {
	if (!billingConfigured()) return [];
	const db = getDb();
	if (!db) return [];
	const [row] = await db.select().from(billing).where(eq(billing.orgId, orgId));
	if (!row?.stripeCustomerId) return [];
	const res = await stripeGet<{ data: RawInvoice[] }>(
		`/invoices?customer=${encodeURIComponent(row.stripeCustomerId)}&limit=${limit}`
	);
	return (res.data ?? []).map((inv) => ({
		id: inv.id,
		number: inv.number ?? null,
		created: new Date(inv.created * 1000).toISOString(),
		total: inv.total,
		currency: inv.currency,
		status: inv.status ?? 'unknown',
		hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
		invoicePdf: inv.invoice_pdf ?? null
	}));
}

// ── Webhook: signature verification + event application ─────────────────────

/**
 * Verify a Stripe-Signature header (scheme v1) against the raw request payload.
 * HMAC-SHA256 over `${timestamp}.${payload}` with the endpoint secret,
 * constant-time comparison, and a replay-tolerance window (default 5 min).
 * Pure node:crypto — no stripe SDK dependency.
 */
export function verifyStripeSignature(
	payload: string,
	header: string,
	secret: string,
	toleranceSec = 300
): boolean {
	let timestamp: number | null = null;
	const signatures: string[] = [];
	for (const part of header.split(',')) {
		const idx = part.indexOf('=');
		if (idx < 0) continue;
		const k = part.slice(0, idx).trim();
		const v = part.slice(idx + 1).trim();
		if (k === 't') timestamp = Number(v);
		else if (k === 'v1') signatures.push(v);
	}
	if (!timestamp || !Number.isFinite(timestamp) || signatures.length === 0) return false;
	if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSec) return false;
	const expected = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
	const expectedBuf = Buffer.from(expected, 'utf8');
	return signatures.some((sig) => {
		const sigBuf = Buffer.from(sig, 'utf8');
		return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
	});
}

type StripePrice = {
	id?: string;
	nickname?: string | null;
	lookup_key?: string | null;
};

type StripeSubscription = {
	id: string;
	customer: string;
	status: string;
	cancel_at_period_end?: boolean;
	/** Unix seconds. Top-level on classic API versions… */
	current_period_end?: number;
	/** …and per-item on 2025+ API versions. */
	items?: { data?: Array<{ current_period_end?: number; price?: StripePrice }> };
	metadata?: { orgId?: string };
};

type StripeEvent = {
	id?: string;
	type?: string;
	data?: { object?: Record<string, unknown> };
};

/** Subscription states that keep the paid plan enabled. */
const PAID_STATUSES = new Set(['active', 'trialing', 'past_due']);

function periodEnd(sub: StripeSubscription): Date | null {
	const unix = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
	return unix ? new Date(unix * 1000) : null;
}

function planNameFor(sub: StripeSubscription): string {
	if (!PAID_STATUSES.has(sub.status)) return 'free';
	const price = sub.items?.data?.[0]?.price;
	return price?.nickname ?? price?.lookup_key ?? 'pro';
}

/** Resolve which org a Stripe customer belongs to: billing row first, then customer metadata. */
async function orgIdForCustomer(customerId: string): Promise<string | null> {
	const db = getDb();
	if (!db) return null;
	const [row] = await db.select().from(billing).where(eq(billing.stripeCustomerId, customerId));
	if (row) return row.orgId;
	try {
		const cust = await stripeGet<{ metadata?: { orgId?: string } }>(
			`/customers/${encodeURIComponent(customerId)}`
		);
		return cust.metadata?.orgId ?? null;
	} catch {
		return null;
	}
}

/** Upsert the org's billing row from a subscription snapshot. */
async function applySubscription(sub: StripeSubscription, knownOrgId?: string | null): Promise<void> {
	const db = getDb();
	if (!db) throw new Error('A database is required for billing');
	const orgId = knownOrgId ?? sub.metadata?.orgId ?? (await orgIdForCustomer(sub.customer));
	if (!orgId) {
		console.warn(`[billing] webhook: no org found for stripe customer ${sub.customer} — skipped`);
		return;
	}
	const set = {
		stripeCustomerId: sub.customer,
		stripeSubscriptionId: sub.id,
		plan: planNameFor(sub),
		status: sub.status,
		currentPeriodEnd: periodEnd(sub),
		updatedAt: new Date()
	};
	await db
		.insert(billing)
		.values({ orgId, ...set })
		.onConflictDoUpdate({ target: billing.orgId, set });
}

/**
 * Apply a (signature-verified) Stripe webhook event to the billing table.
 * Handles checkout completion and subscription lifecycle; every other event
 * type is acknowledged without side effects. Returns what was done for logs.
 */
export async function applyStripeEvent(event: StripeEvent): Promise<string> {
	const type = event.type ?? '';
	const obj = (event.data?.object ?? {}) as Record<string, unknown>;

	if (type === 'checkout.session.completed') {
		const orgId =
			(typeof obj.client_reference_id === 'string' ? obj.client_reference_id : null) ??
			(obj.metadata as { orgId?: string } | undefined)?.orgId ??
			null;
		const customer = typeof obj.customer === 'string' ? obj.customer : null;
		const subscriptionId = typeof obj.subscription === 'string' ? obj.subscription : null;
		if (!subscriptionId) return 'checkout.session.completed without subscription — ignored';
		// Pull the full subscription for status/price/period-end. If the fetch
		// fails (e.g. key rotated), fall back to a minimal 'active' upsert so the
		// paying org is never left on the free plan.
		try {
			const sub = await stripeGet<StripeSubscription>(
				`/subscriptions/${encodeURIComponent(subscriptionId)}`
			);
			await applySubscription(sub, orgId);
			return `subscription ${sub.id} applied (${sub.status})`;
		} catch (e) {
			const resolvedOrg = orgId ?? (customer ? await orgIdForCustomer(customer) : null);
			if (!resolvedOrg || !customer) throw e;
			const db = getDb();
			if (!db) throw new Error('A database is required for billing');
			const set = {
				stripeCustomerId: customer,
				stripeSubscriptionId: subscriptionId,
				plan: 'pro',
				status: 'active',
				updatedAt: new Date()
			};
			await db
				.insert(billing)
				.values({ orgId: resolvedOrg, ...set })
				.onConflictDoUpdate({ target: billing.orgId, set });
			return `subscription ${subscriptionId} applied via checkout fallback`;
		}
	}

	if (
		type === 'customer.subscription.created' ||
		type === 'customer.subscription.updated'
	) {
		const sub = obj as unknown as StripeSubscription;
		await applySubscription(sub);
		return `subscription ${sub.id} applied (${sub.status})`;
	}

	if (type === 'customer.subscription.deleted') {
		const sub = obj as unknown as StripeSubscription;
		const db = getDb();
		if (!db) throw new Error('A database is required for billing');
		const orgId = sub.metadata?.orgId ?? (await orgIdForCustomer(sub.customer));
		if (!orgId) return `subscription ${sub.id} deleted but no org found — ignored`;
		await db
			.update(billing)
			.set({
				plan: 'free',
				status: 'canceled',
				stripeSubscriptionId: null,
				currentPeriodEnd: periodEnd(sub),
				updatedAt: new Date()
			})
			.where(eq(billing.orgId, orgId));
		return `subscription ${sub.id} canceled — org ${orgId} downgraded to free`;
	}

	return `event ${type || '(unknown)'} ignored`;
}
