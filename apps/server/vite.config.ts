import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],

	// Stop Vite from walking up into the prototype's postcss.config.mjs
	// (this repo is nested inside the prototype directory).
	css: {
		postcss: {}
	}
});
