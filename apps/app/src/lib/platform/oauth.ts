/**
 * Experimental "Sign in with ChatGPT" for the Tauri desktop app. PKCE (S256) is
 * computed here via WebCrypto; the Rust `oauth_start`/`oauth_complete` commands
 * run a loopback listener to capture the redirect; the token exchange is proxied
 * by the server; tokens are stored in the OS keyring via the `secrets_*` commands.
 *
 * Access tokens are refreshed automatically: getChatGptToken() compares the
 * stored expiry against now and, when the token is missing/near expiry, renews
 * it through the server's exchange proxy with the stored refresh token
 * (grantType: 'refresh_token') before returning. On refresh failure the stored
 * token is returned only while still valid; afterwards null — callers should
 * treat null as "reconnect required" (see getChatGptConnectionStatus()).
 *
 * OFF-LABEL / experimental (consumer ChatGPT subscription). Desktop only. Google
 * consumer OAuth is retired — use a BYO Gemini (AI Studio) API key instead.
 */
import { isTauri } from './index';

// OpenAI's public Codex-CLI OAuth client id (native/desktop, PKCE). Overridable.
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE = 'https://auth.openai.com/oauth/authorize';
const SCOPE = 'openid profile email offline_access';
const ACCESS_KEY = 'ai.oauth.chatgpt.access';
const REFRESH_KEY = 'ai.oauth.chatgpt.refresh';
const EXPIRES_KEY = 'ai.oauth.chatgpt.expires';

/** Same resolution as lib/api.ts — the exchange proxy lives on the API server. */
const DEFAULT_API_BASE: string = import.meta.env.VITE_API_URL ?? 'http://localhost:5174';

/** Refresh this long before the recorded expiry (clock skew + request latency). */
const EXPIRY_SKEW_MS = 2 * 60 * 1000;

export function chatGptOAuthSupported(): boolean {
	return isTauri();
}

function b64url(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randB64url(n: number): string {
	const a = new Uint8Array(n);
	crypto.getRandomValues(a);
	return b64url(a);
}
async function sha256b64url(input: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	return b64url(new Uint8Array(digest));
}

async function secretGet(key: string): Promise<string | null> {
	try {
		const { invoke } = await import('@tauri-apps/api/core');
		return await invoke<string | null>('secrets_get', { key });
	} catch {
		return null;
	}
}

interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
}

async function storeTokens(tokens: TokenResponse): Promise<void> {
	const { invoke } = await import('@tauri-apps/api/core');
	if (tokens.access_token) await invoke('secrets_set', { key: ACCESS_KEY, value: tokens.access_token });
	if (tokens.refresh_token) await invoke('secrets_set', { key: REFRESH_KEY, value: tokens.refresh_token });
	if (tokens.expires_in) {
		await invoke('secrets_set', { key: EXPIRES_KEY, value: String(Date.now() + tokens.expires_in * 1000) });
	}
}

/** Run the full sign-in flow. Returns a short hint of the stored token. */
export async function signInWithChatGpt(apiBaseUrl: string = DEFAULT_API_BASE): Promise<{ hint: string }> {
	if (!isTauri()) throw new Error('ChatGPT sign-in is available on the desktop app only');
	const { invoke } = await import('@tauri-apps/api/core');

	const verifier = randB64url(48);
	const challenge = await sha256b64url(verifier);
	const stateNonce = randB64url(16);

	const port = await invoke<number>('oauth_start');
	const redirectUri = `http://localhost:${port}/callback`;
	const authorizeUrl =
		`${AUTHORIZE}?response_type=code&client_id=${encodeURIComponent(CLIENT_ID)}` +
		`&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPE)}` +
		`&code_challenge=${challenge}&code_challenge_method=S256&state=${stateNonce}&prompt=login`;

	const captured = await invoke<{ code: string; state: string }>('oauth_complete', { authorizeUrl });
	if (captured.state !== stateNonce) throw new Error('OAuth state mismatch — aborting');

	const res = await fetch(`${apiBaseUrl}/api/ai-oauth/exchange`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify({ code: captured.code, verifier, redirectUri, clientId: CLIENT_ID })
	});
	if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
	const tokens = (await res.json()) as TokenResponse;
	if (!tokens.access_token) throw new Error('Token exchange returned no access token');

	await storeTokens(tokens);
	return { hint: `••••${tokens.access_token.slice(-4)}` };
}

// One refresh at a time — parallel copilot requests share the same renewal.
let refreshInflight: Promise<string | null> | null = null;

/**
 * Renew the access token via the refresh_token grant (through the server
 * proxy). Returns the fresh access token, or null when no refresh token is
 * stored / the grant is rejected. Never throws.
 */
export async function refreshChatGptToken(apiBaseUrl: string = DEFAULT_API_BASE): Promise<string | null> {
	if (!isTauri()) return null;
	if (refreshInflight) return refreshInflight;
	refreshInflight = (async () => {
		try {
			const refreshToken = await secretGet(REFRESH_KEY);
			if (!refreshToken) return null;
			const res = await fetch(`${apiBaseUrl}/api/ai-oauth/exchange`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ grantType: 'refresh_token', refreshToken, clientId: CLIENT_ID })
			});
			if (!res.ok) return null;
			const tokens = (await res.json()) as TokenResponse;
			if (!tokens.access_token) return null;
			await storeTokens(tokens);
			return tokens.access_token;
		} catch {
			return null;
		} finally {
			refreshInflight = null;
		}
	})();
	return refreshInflight;
}

/**
 * The current usable access token: refreshes before expiry (using the stored
 * expiry + refresh token) instead of forwarding a stale token. Null when
 * disconnected or when the session expired and could not be refreshed.
 */
export async function getChatGptToken(apiBaseUrl: string = DEFAULT_API_BASE): Promise<string | null> {
	if (!isTauri()) return null;
	try {
		const access = await secretGet(ACCESS_KEY);
		const expiresRaw = await secretGet(EXPIRES_KEY);
		const expiresAt = expiresRaw ? Number(expiresRaw) : null;
		const stillFresh = !!access && (!expiresAt || !Number.isFinite(expiresAt) || Date.now() < expiresAt - EXPIRY_SKEW_MS);
		if (stillFresh) return access;

		const refreshed = await refreshChatGptToken(apiBaseUrl);
		if (refreshed) return refreshed;

		// Refresh unavailable/failed — usable only while not hard-expired.
		if (access && (!expiresAt || !Number.isFinite(expiresAt) || Date.now() < expiresAt)) return access;
		return null;
	} catch {
		return null;
	}
}

/**
 * Connection state for settings UIs: `connected` = a usable token exists now;
 * `needsReconnect` = tokens are stored but expired and refresh failed (the
 * user must run signInWithChatGpt again).
 */
export async function getChatGptConnectionStatus(apiBaseUrl: string = DEFAULT_API_BASE): Promise<{
	connected: boolean;
	needsReconnect: boolean;
	expiresAt: number | null;
	hasRefreshToken: boolean;
}> {
	if (!isTauri()) return { connected: false, needsReconnect: false, expiresAt: null, hasRefreshToken: false };
	const hasStored = !!(await secretGet(ACCESS_KEY)) || !!(await secretGet(REFRESH_KEY));
	const expiresRaw = await secretGet(EXPIRES_KEY);
	const expiresAt = expiresRaw && Number.isFinite(Number(expiresRaw)) ? Number(expiresRaw) : null;
	const token = await getChatGptToken(apiBaseUrl);
	return {
		connected: !!token,
		needsReconnect: !token && hasStored,
		expiresAt,
		hasRefreshToken: !!(await secretGet(REFRESH_KEY))
	};
}

export async function signOutChatGpt(): Promise<void> {
	if (!isTauri()) return;
	const { invoke } = await import('@tauri-apps/api/core');
	for (const key of [ACCESS_KEY, REFRESH_KEY, EXPIRES_KEY]) {
		try {
			await invoke('secrets_delete', { key });
		} catch {
			/* ignore */
		}
	}
}
