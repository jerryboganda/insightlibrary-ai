import { ApiClient } from '@insightlibrary/api-client';
import { getPlatform, isTauri } from './platform';

/**
 * API base URL:
 * - dev/desktop: the local SvelteKit API server on :5174
 * - production web: PUBLIC_API_URL injected at build time (same-origin or api.*)
 * Configure via Vite env when deploying; defaults to local dev.
 */
const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:5174';

export const api = new ApiClient({
	baseUrl: API_BASE,
	// Tauri: send the session token from the OS keyring as a bearer header.
	// Web: no token here — better-auth cookie sessions travel automatically.
	getToken: async () => {
		if (!isTauri()) return null;
		const platform = await getPlatform();
		return platform.secrets.get('session_token').catch(() => null);
	}
});
