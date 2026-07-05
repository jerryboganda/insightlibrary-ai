import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { billingConfigured, listInvoices } from '$lib/server/billing/stripe';
import { requireRole } from '$lib/server/auth-guard';

/**
 * GET /api/billing/invoices — real invoice history proxied from Stripe for the
 * org's customer. Returns { configured, invoices } so the billing page can show
 * an honest empty/unconfigured state instead of fabricated rows.
 */
export const GET: RequestHandler = async ({ locals }) => {
	requireRole(locals.user, 'admin');
	if (!billingConfigured()) return json({ configured: false, invoices: [] });
	try {
		const invoices = await listInvoices(locals.user?.orgId || 'org_1');
		return json({ configured: true, invoices });
	} catch (e) {
		throw error(502, e instanceof Error ? e.message : 'invoice lookup failed');
	}
};
