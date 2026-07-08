import { redirect, isRedirect } from '@sveltejs/kit';
import { api } from '$lib/api';
import type { LayoutLoad } from './$types';

/**
 * Client-side auth guard for the app shell (SPA mode — see the root `+layout.ts`
 * `ssr = false`). Everything under `(app)` requires an authenticated session;
 * anonymous or errored sessions are bounced to `/login`. The resolved user/org
 * is returned so child routes and the shell can read it without re-fetching.
 */
export const load: LayoutLoad = async () => {
	try {
		const session = await api.session();
		if (!session.authenticated || !session.user) {
			throw redirect(302, '/login');
		}
		return {
			user: session.user,
			org: session.org ?? null,
			platformRole: session.platformRole ?? 'user'
		};
	} catch (e) {
		// Re-throw SvelteKit's redirect untouched; treat any real failure (network,
		// unreachable API) as "not authenticated" and send the user to sign in.
		if (isRedirect(e)) throw e;
		throw redirect(302, '/login');
	}
};
