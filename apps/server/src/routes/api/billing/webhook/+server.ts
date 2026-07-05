import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { applyStripeEvent, verifyStripeSignature, webhookConfigured } from '$lib/server/billing/stripe';

/**
 * POST /api/billing/webhook — Stripe event sink (checkout.session.completed,
 * customer.subscription.created/updated/deleted). This is what actually
 * upgrades/downgrades an org after payment.
 *
 * Auth: intentionally NOT session/role guarded — Stripe calls it server-to-server.
 * Authenticity comes from the Stripe-Signature header, verified against
 * STRIPE_WEBHOOK_SECRET over the raw body (HMAC-SHA256, 5-min replay window,
 * constant-time compare). SvelteKit's CSRF origin check only applies to form
 * content types, and the auth hook treats missing credentials as anonymous, so
 * Stripe's application/json POST reaches this handler unimpeded.
 */
export const POST: RequestHandler = async ({ request }) => {
	const secret = process.env.STRIPE_WEBHOOK_SECRET;
	if (!secret || !webhookConfigured()) {
		throw error(503, 'Stripe webhook not configured (set STRIPE_WEBHOOK_SECRET).');
	}

	// Signature is computed over the exact raw bytes — read text before parsing.
	const payload = await request.text();
	const signature = request.headers.get('stripe-signature');
	if (!signature || !verifyStripeSignature(payload, signature, secret)) {
		throw error(400, 'Invalid Stripe signature');
	}

	let event: unknown;
	try {
		event = JSON.parse(payload);
	} catch {
		throw error(400, 'Invalid JSON payload');
	}

	try {
		const outcome = await applyStripeEvent(event as Parameters<typeof applyStripeEvent>[0]);
		console.info(`[billing] webhook: ${outcome}`);
	} catch (e) {
		// 5xx makes Stripe retry with backoff — correct for transient DB failures.
		console.error('[billing] webhook failed:', e instanceof Error ? e.message : e);
		throw error(500, 'Webhook processing failed');
	}

	return json({ received: true });
};
