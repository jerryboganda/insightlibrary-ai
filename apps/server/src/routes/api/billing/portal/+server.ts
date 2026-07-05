import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createPortal, billingConfigured } from '$lib/server/billing/stripe';
import { requireRole } from '$lib/server/auth-guard';

/** POST /api/billing/portal — open the Stripe Billing Portal; returns { url }. */
export const POST: RequestHandler = async ({ request, locals, url }) => {
	requireRole(locals.user, 'admin');
	if (!billingConfigured()) throw error(503, 'Billing is not configured (set STRIPE_SECRET_KEY).');
	const origin = request.headers.get('origin') ?? url.origin;
	try {
		const portalUrl = await createPortal(locals.user?.orgId || 'org_1', `${origin}/admin/settings/billing`);
		return json({ url: portalUrl });
	} catch (e) {
		throw error(502, e instanceof Error ? e.message : 'portal failed');
	}
};
