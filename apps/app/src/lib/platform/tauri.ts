import { invoke } from '@tauri-apps/api/core';
import type { PlatformAdapter } from './types';

/**
 * Tauri implementation. Secrets live in the OS credential store (keyring crate)
 * behind Rust commands — never in webview localStorage, which ships in plain
 * text inside the app's data directory.
 *
 * The matching Rust commands (`secrets_get`/`secrets_set`/`secrets_delete`)
 * land with the auth work; calling these before then rejects loudly rather
 * than silently degrading.
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
