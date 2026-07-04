import type { PlatformAdapter } from './types';

export type { PlatformAdapter, SecretsAdapter } from './types';

/** True when running inside a Tauri webview (any OS, desktop or mobile). */
export function isTauri(): boolean {
	return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Platform name without loading any adapter code. */
export function platformName(): 'tauri' | 'web' {
	return isTauri() ? 'tauri' : 'web';
}

let cached: PlatformAdapter | null = null;

/**
 * Resolve the platform adapter for the current runtime. Adapters are loaded
 * lazily so web bundles never include `@tauri-apps/*` code paths.
 */
export async function getPlatform(): Promise<PlatformAdapter> {
	if (!cached) {
		cached = isTauri()
			? (await import('./tauri')).tauriPlatform
			: (await import('./web')).webPlatform;
	}
	return cached;
}
