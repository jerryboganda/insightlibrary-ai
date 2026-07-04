/**
 * Platform adapter — the ONLY place where target-specific APIs may be touched.
 * Application code imports from `$lib/platform` and never from `@tauri-apps/*`
 * directly, so web bundles stay free of Tauri APIs and each capability has an
 * explicit browser fallback (or an explicit "unsupported").
 */

export interface SecretsAdapter {
	/** Retrieve a secret (e.g. session token). Returns null when absent. */
	get(key: string): Promise<string | null>;
	set(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
}

export interface PlatformAdapter {
	readonly name: 'tauri' | 'web';
	readonly secrets: SecretsAdapter;
	// Future capabilities added as features land:
	// fileAccess: native dialogs (Tauri) vs <input type="file"> (web)
	// offlineCache: SQLite (Tauri) vs IndexedDB (web)
	// updates: tauri-plugin-updater (desktop) vs no-op (web)
}
