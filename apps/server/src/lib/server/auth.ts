import { env } from '$env/dynamic/private';
import type { SessionUser } from '@insightlibrary/schemas';
import { seedOrg, seedUsers } from './data/seed';
import { auth } from './auth-config';

/**
 * Auth strategy:
 * - With DATABASE_URL: better-auth (organization + admin + bearer plugins) backs
 *   real multi-tenant sessions. Run `pnpm --filter @insightlibrary/server db:auth`
 *   once to create its tables (see AUTH.md).
 * - Without DATABASE_URL (local dev): auth is bypassed and every request is the
 *   seeded owner, so all screens are reachable with zero setup.
 */

export const DEV_SESSION_USER: SessionUser = {
	id: seedUsers[0].id,
	name: seedUsers[0].name,
	email: seedUsers[0].email,
	role: seedUsers[0].role,
	orgId: seedOrg.id,
	orgName: seedOrg.name,
	tenantId: seedOrg.tenantId
};

export function isAuthEnabled(): boolean {
	return Boolean(env.DATABASE_URL);
}

/** The better-auth instance (present when auth is enabled), or null in dev. */
export function getAuth() {
	return isAuthEnabled() ? auth : null;
}
