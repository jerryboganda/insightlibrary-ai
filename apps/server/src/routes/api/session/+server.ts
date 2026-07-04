import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sessionResponseSchema } from '@insightlibrary/schemas';

/**
 * Returns the current session. `event.locals.user` is populated by the auth
 * hook — in dev (no DB) it's the seeded admin; with better-auth it's the real
 * session user.
 */
export const GET: RequestHandler = ({ locals }) => {
	return json(
		sessionResponseSchema.parse({
			authenticated: locals.user !== null,
			user: locals.user
		})
	);
};
