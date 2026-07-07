import { ApiClient } from '@insightlibrary/api-client';
import { getPlatform, isTauri } from './platform';
import { SESSION_TOKEN_KEY, SESSION_REFRESH_KEY } from './auth-keys';

/**
 * API base URL:
 * - dev/desktop: the local API server on :5174
 * - production web: VITE_API_URL is inlined at build time (e.g. the api.* origin).
 * Configure via Vite env when deploying; defaults to local dev.
 */
const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:5174';

export const api = new ApiClient({
	baseUrl: API_BASE,
	// Tauri: send the access token from the OS keyring as a Bearer header.
	// Web: no token here — cookie sessions travel automatically.
	getToken: async () => {
		if (!isTauri()) return null;
		const platform = await getPlatform();
		return platform.secrets.get(SESSION_TOKEN_KEY).catch(() => null);
	},
	// Tauri: the refresh token for the 401→refresh→retry flow. Web returns null
	// and relies on the refresh cookie the server scoped to /api/auth.
	getRefreshToken: async () => {
		if (!isTauri()) return null;
		const platform = await getPlatform();
		return platform.secrets.get(SESSION_REFRESH_KEY).catch(() => null);
	},
	// Persist rotated tokens after sign-in / sign-up / refresh (desktop keyring).
	// Web is a no-op: the server rotates the httpOnly cookies itself.
	onTokens: async ({ accessToken, refreshToken }) => {
		if (!isTauri()) return;
		try {
			const platform = await getPlatform();
			await platform.secrets.set(SESSION_TOKEN_KEY, accessToken);
			await platform.secrets.set(SESSION_REFRESH_KEY, refreshToken);
		} catch (e) {
			console.error(
				'[auth] failed to persist session tokens to keyring:',
				e instanceof Error ? e.message : e
			);
		}
	},
	// Desktop only: forward a connected ChatGPT subscription token so the copilot
	// runs on the user's subscription (experimental / off-label).
	getAiToken: async () => {
		if (!isTauri()) return null;
		const { getChatGptToken } = await import('./platform/oauth');
		return getChatGptToken().catch(() => null);
	}
});
