import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAuth, isAuthEnabled } from '$lib/server/auth';

/**
 * better-auth catch-all. Handles sign-in/up, sessions, org, SSO, and bearer
 * endpoints. In dev (no DATABASE_URL) auth is bypassed, so this returns 501.
 */
const handler: RequestHandler = async ({ request }) => {
	if (!isAuthEnabled()) throw error(501, 'Auth is disabled in dev (no DATABASE_URL). Seeded admin is used.');
	const auth = await getAuth();
	return auth.handler(request);
};

export const GET = handler;
export const POST = handler;
