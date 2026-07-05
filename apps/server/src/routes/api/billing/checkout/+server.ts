import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createCheckout, billingConfigured } from '$lib/server/billing/stripe';
import { requireRole } from '$lib/server/auth-guard';

/** POST /api/billing/checkout — start a Stripe subscription Checkout; returns { url }. */
export const POST: RequestHandler = async ({ request, locals, url }) => {
	requireRole(locals.user, 'admin');
	if (!billingConfigured()) throw error(503, 'Billing is not configured (set STRIPE_SECRET_KEY + STRIPE_PRICE_ID).');
	const body = (await request.json().catch(() => ({}))) as { priceId?: string };
	const origin = request.headers.get('origin') ?? url.origin;
	try {
		const checkoutUrl = await createCheckout(locals.user?.orgId || 'org_1', {
			priceId: body.priceId,
			successUrl: `${origin}/admin/settings/billing?checkout=success`,
			cancelUrl: `${origin}/admin/settings/billing?checkout=cancelled`,
			email: locals.user?.email
		});
		return json({ url: checkoutUrl });
	} catch (e) {
		throw error(502, e instanceof Error ? e.message : 'checkout failed');
	}
};
