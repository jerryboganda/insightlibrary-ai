import type { PlatformAdapter } from './types';

/**
 * Browser implementation. Auth on web uses better-auth cookie sessions, so the
 * secrets adapter is intentionally minimal — sessionStorage keeps nothing across
 * browser restarts and is only a stopgap for non-auth secrets.
 */
export const webPlatform: PlatformAdapter = {
	name: 'web',
	secrets: {
		async get(key) {
			return sessionStorage.getItem(`il:${key}`);
		},
		async set(key, value) {
			sessionStorage.setItem(`il:${key}`, value);
		},
		async delete(key) {
			sessionStorage.removeItem(`il:${key}`);
		}
	}
};
