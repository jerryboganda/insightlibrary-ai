import { defineConfig } from 'vitest/config';

// Plain Node unit tests for server logic — no SvelteKit plugin so pure modules
// (repository, chunking, schemas) test in isolation without the app runtime.
export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts']
	}
});
