// SPA mode (Tauri's recommended SvelteKit setup): all rendering happens in the
// webview/browser, where load functions have access to Tauri APIs. Unknown paths
// fall back to index.html (see svelte.config.js) so runtime-created routes like
// /folders/<id> resolve client-side.
export const ssr = false;
