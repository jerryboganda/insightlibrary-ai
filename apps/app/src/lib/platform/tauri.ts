import { invoke } from '@tauri-apps/api/core';
import type { PlatformAdapter } from './types';

/**
 * Tauri implementation. Secrets live in the OS credential store (keyring crate)
 * behind Rust commands — never in webview localStorage, which ships in plain
 * text inside the app's data directory.
 *
 * Used by the auth flow: `$lib/auth-client` writes the better-auth bearer
 * session token here on sign-in (key `session_token`) and deletes it on
 * sign-out; `$lib/api` reads it for the Authorization header. If the matching
 * Rust commands (`secrets_get`/`secrets_set`/`secrets_delete`) are missing,
 * these calls reject loudly rather than silently degrading.
 */
export const tauriPlatform: PlatformAdapter = {
	name: 'tauri',
	secrets: {
		async get(key) {
			return await invoke<string | null>('secrets_get', { key });
		},
		async set(key, value) {
			await invoke('secrets_set', { key, value });
		},
		async delete(key) {
			await invoke('secrets_delete', { key });
		}
	}
};
