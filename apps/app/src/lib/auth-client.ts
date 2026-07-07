import { ApiError } from '@insightlibrary/api-client';
import { api } from '$lib/api';
import { getPlatform, isTauri } from '$lib/platform';
import { SESSION_TOKEN_KEY, SESSION_REFRESH_KEY } from '$lib/auth-keys';

/**
 * Auth client — an ApiClient-backed shim over the Rust API's `/api/auth/*`
 * endpoints. It preserves the exact call/return surface the login and settings
 * pages depend on (previously supplied by better-auth), so those pages are
 * unchanged.
 *
 * - Web: same-origin cookie sessions travel automatically (`credentials:'include'`).
 * - Desktop (Tauri): sign-in/up return `{ accessToken, refreshToken }` in the body;
 *   `$lib/api` persists them to the OS keyring via `onTokens`, and reads the access
 *   token back for the Bearer header. No response-header capture is needed.
 */

/** Re-exported for callers that key the desktop keyring by name. */
export { SESSION_TOKEN_KEY };

/** Pull a human-readable message out of an ApiError body (JSON `{message|error|
 * detail}` else raw text), or any other thrown value. */
function errorMessage(e: unknown): string {
	if (e instanceof ApiError) {
		try {
			const parsed = JSON.parse(e.body) as Record<string, unknown>;
			const msg = parsed.message ?? parsed.error ?? parsed.detail;
			if (typeof msg === 'string' && msg.trim()) return msg;
		} catch {
			// Body was not JSON — fall through to the raw text.
		}
		return e.body?.trim() || `Request failed (${e.status})`;
	}
	return e instanceof Error ? e.message : 'Something went wrong.';
}

type AuthResult = { data?: unknown; error?: { status: number; message: string } };

/** Run an auth call, mapping success/failure to the `{ data, error }` shape the
 * login page expects (it reads `error.status` and `error.message`). */
async function run(fn: () => Promise<unknown>): Promise<AuthResult> {
	try {
		return { data: await fn() };
	} catch (e) {
		return { error: { status: e instanceof ApiError ? e.status : 0, message: errorMessage(e) } };
	}
}

export const authClient = {
	signIn: {
		email: (input: { email: string; password: string }) => run(() => api.signIn(input))
	},
	signUp: {
		email: (input: { email: string; password: string; name: string }) =>
			run(() => api.signUp(input))
	},
	signOut: async () => {
		try {
			await api.signOut();
		} catch {
			// Best-effort: the local keyring is still cleared by signOutEverywhere.
		}
	},
	getSession: async () => {
		try {
			const s = await api.session();
			return {
				data: { session: { token: s.sessionToken ?? null }, user: s.user },
				error: undefined
			};
		} catch {
			return { data: { session: { token: null }, user: null }, error: undefined };
		}
	},
	listSessions: async () => {
		try {
			const r = await api.listAuthSessions();
			return { data: r.items, error: undefined };
		} catch (e) {
			return { data: undefined, error: { message: errorMessage(e) } };
		}
	},
	revokeSession: async ({ token }: { token: string }) => {
		await api.revokeAuthSession(token);
	},
	revokeOtherSessions: async () => {
		await api.revokeOtherAuthSessions();
	}
};

/** Remove the desktop keyring session tokens. No-op on web or when absent. */
export async function clearSessionToken(): Promise<void> {
	if (!isTauri()) return;
	try {
		const platform = await getPlatform();
		await platform.secrets.delete(SESSION_TOKEN_KEY);
		await platform.secrets.delete(SESSION_REFRESH_KEY);
	} catch {
		// Keys were never written (web-style session) — nothing to clear.
	}
}

/**
 * Sign out everywhere: revoke the server session (cookie + refresh jti) and wipe
 * the desktop keyring tokens so `$lib/api` stops sending a stale Bearer header.
 */
export async function signOutEverywhere(): Promise<void> {
	await authClient.signOut();
	await clearSessionToken();
}
