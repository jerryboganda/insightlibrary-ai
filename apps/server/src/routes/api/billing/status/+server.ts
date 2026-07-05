import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getBillingStatus } from '$lib/server/billing/stripe';

/** GET /api/billing/status — plan + subscription status for the billing page. */
export const GET: RequestHandler = async ({ locals }) => {
	return json(await getBillingStatus(locals.user?.orgId || 'org_1'));
};
