import adapterStatic from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// One codebase, multiple delivery targets:
//   desktop (default) → static SPA consumed by the Tauri shell (frontendDist)
//   web               → the same static SPA, deployed to any static host/CDN
// If the web target ever needs SSR (SEO/first-paint for public pages), swap in
// @sveltejs/adapter-node for the 'web' case here — no application code changes.
const target = process.env.BUILD_TARGET ?? 'desktop';

function adapterFor(buildTarget) {
	switch (buildTarget) {
		case 'desktop':
		case 'web':
		default:
			return adapterStatic({
				// SPA mode: unknown paths (e.g. /folders/<runtime-id>) fall back to
				// index.html and the client router resolves them.
				fallback: 'index.html',
				strict: false
			});
	}
}

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapterFor(target)
	}
};

export default config;
