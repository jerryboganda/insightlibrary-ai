import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter()
		// Reminder (verified): adapter-node's BODY_SIZE_LIMIT defaults to 512 KB.
		// File uploads must NEVER be proxied through this server — clients upload
		// directly to S3/MinIO via presigned URLs issued by an API route.
	}
};

export default config;
