import { createAuthClient } from 'better-auth/svelte';

/**
 * better-auth client. Talks to the API's /api/auth/* endpoints. On web this uses
 * same-origin cookie sessions; in dev (no server DB) auth is bypassed, so the
 * login page falls straight through.
 */
const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:5174';

export const authClient = createAuthClient({
	baseURL: API_BASE
});
