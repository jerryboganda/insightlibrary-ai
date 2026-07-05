/**
 * Experimental "Sign in with ChatGPT" for the Tauri desktop app. PKCE (S256) is
 * computed here via WebCrypto; the Rust `oauth_start`/`oauth_complete` commands
 * run a loopback listener to capture the redirect; the token exchange is proxied
 * by the server; tokens are stored in the OS keyring via the `secrets_*` commands.
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

/** Run the full sign-in flow. Returns a short hint of the stored token. */
export async function signInWithChatGpt(apiBaseUrl: string): Promise<{ hint: string }> {
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
	const tokens = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };

	await invoke('secrets_set', { key: ACCESS_KEY, value: tokens.access_token });
	if (tokens.refresh_token) await invoke('secrets_set', { key: REFRESH_KEY, value: tokens.refresh_token });
	if (tokens.expires_in) await invoke('secrets_set', { key: EXPIRES_KEY, value: String(Date.now() + tokens.expires_in * 1000) });

	return { hint: `••••${tokens.access_token.slice(-4)}` };
}

export async function getChatGptToken(): Promise<string | null> {
	if (!isTauri()) return null;
	try {
		const { invoke } = await import('@tauri-apps/api/core');
		return await invoke<string | null>('secrets_get', { key: ACCESS_KEY });
	} catch {
		return null;
	}
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
