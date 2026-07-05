/**
 * Stripe billing (hosted-tier). Thin REST client via fetch (no SDK dep) behind
 * STRIPE_SECRET_KEY. Creates/looks up a per-org customer, opens Checkout for a
 * subscription (STRIPE_PRICE_ID), and the Billing Portal for self-service.
 * No-ops with a clear 503 when unconfigured. Worker/route safe (process.env).
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { billing } from '../db/schema';

const STRIPE_BASE = 'https://api.stripe.com/v1';
const key = () => process.env.STRIPE_SECRET_KEY ?? null;
export const billingConfigured = () => !!key();

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
		cancel_url: opts.cancelUrl
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
