import type { SessionUser } from '@insightlibrary/schemas';

// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	namespace App {
		interface Locals {
			/** Resolved by the auth hook: seeded admin in dev, better-auth session otherwise. */
			user: SessionUser | null;
		}
	}
}

export {};
