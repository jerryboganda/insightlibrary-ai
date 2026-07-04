import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],

	// Tailwind runs via the Vite plugin above, not PostCSS. An explicit empty
	// PostCSS config also stops Vite from walking up the directory tree and
	// loading the prototype's postcss.config.mjs (this repo lives inside it).
	css: {
		postcss: {}
	},

	// Tauri expects a fixed port during `tauri dev`; fail instead of drifting.
	clearScreen: false,
	server: {
		port: 5173,
		strictPort: true,
		watch: {
			ignored: ['**/src-tauri/**']
		}
	}
});
