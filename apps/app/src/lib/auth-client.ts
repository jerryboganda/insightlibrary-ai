import { createAuthClient } from 'better-auth/svelte';
import { getPlatform, isTauri } from '$lib/platform';

/**
 * better-auth client. Talks to the API's /api/auth/* endpoints. On web this uses
 * same-origin cookie sessions; in dev (no server DB) auth is bypassed, so the
 * login page falls straight through.
 *
 * Desktop (Tauri): the server's better-auth `bearer` plugin returns the session
 * token in a `set-auth-token` response header on sign-in/up. We capture it here
 * and store it in the OS keyring so `api.ts` can send it as a Bearer header —
 * the Tauri webview cannot rely on cookies surviving across origins/restarts.
 */
const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:5174';

/** Keyring key for the desktop session token — must match api.ts getToken. */
export const SESSION_TOKEN_KEY = 'session_token';

export const authClient = createAuthClient({
	baseURL: API_BASE,
	fetchOptions: {
		onSuccess: async (ctx) => {
			if (!isTauri()) return;
			// bearer plugin: fresh session token rides on this header after sign-in.
			const token = ctx.response.headers.get('set-auth-token');
			if (!token) return;
			try {
				const platform = await getPlatform();
				await platform.secrets.set(SESSION_TOKEN_KEY, token);
			} catch (e) {
				console.error(
					'[auth] failed to persist session token to keyring:',
					e instanceof Error ? e.message : e
				);
			}
		}
	}
});

/** Remove the desktop keyring session token. No-op on web or when absent. */
export async function clearSessionToken(): Promise<void> {
	if (!isTauri()) return;
	try {
		const platform = await getPlatform();
		await platform.secrets.delete(SESSION_TOKEN_KEY);
	} catch {
		// Key was never written (web-style session) — nothing to clear.
	}
}

/**
 * Sign out everywhere: revoke the better-auth session (cookie/bearer) and wipe
 * the desktop keyring token so `api.ts` stops sending a stale Bearer header.
 */
export async function signOutEverywhere(): Promise<void> {
	try {
		await authClient.signOut();
	} catch {
		// Dev-bypass servers have no auth endpoints; a network blip should still
		// not strand the local token below.
	}
	await clearSessionToken();
}
