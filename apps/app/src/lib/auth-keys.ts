/**
 * Keyring/storage keys for the desktop session tokens. Kept in a tiny shared
 * module so both `$lib/api` (the reader) and `$lib/auth-client` (the writer)
 * agree on the exact keys without importing each other (avoids a cycle).
 *
 * Web relies on same-origin cookie sessions and never persists these; the keys
 * only matter inside the Tauri OS keyring.
 */
export const SESSION_TOKEN_KEY = 'session_token';
export const SESSION_REFRESH_KEY = 'session_refresh_token';
