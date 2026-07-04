import { env } from '$env/dynamic/private';
import type { SessionUser } from '@insightlibrary/schemas';
import { seedOrg, seedUsers } from './data/seed';

/**
 * Auth strategy:
 * - With DATABASE_URL: better-auth (organization + SSO + admin plugins) backs
 *   real multi-tenant sessions. Web uses cookie sessions; the Tauri client uses
 *   the bearer plugin with the token stored in the OS keyring.
 * - Without DATABASE_URL (local dev): auth is bypassed and every request is the
 *   seeded owner, so all screens are reachable with zero setup.
 *
 * better-auth is initialized lazily to avoid requiring a DB connection at import
 * time. The instance is created on first use in the DB path.
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let authInstance: any = null;

/**
 * Build (once) and return the better-auth instance. Only call in the DB path.
 * Returns the configured auth object whose `.handler` and `.api` are used by the
 * catch-all route and the auth hook respectively.
 */
export async function getAuth() {
	if (!isAuthEnabled()) return null;
	if (authInstance) return authInstance;

	const { betterAuth } = await import('better-auth');
	const { organization, admin, bearer } = await import('better-auth/plugins');
	const { drizzleAdapter } = await import('better-auth/adapters/drizzle');
	const { drizzle } = await import('drizzle-orm/node-postgres');
	const pg = (await import('pg')).default;
	const schema = await import('./db/schema');

	const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
	const db = drizzle(pool, { schema });

	authInstance = betterAuth({
		secret: env.BETTER_AUTH_SECRET,
		baseURL: env.BETTER_AUTH_URL,
		database: drizzleAdapter(db, { provider: 'pg' }),
		emailAndPassword: { enabled: true },
		// bearer: Tauri webview stores the token in the OS keyring (cross-origin
		// cookies in webviews are unreliable). Web keeps cookie sessions.
		plugins: [organization(), admin(), bearer()]
	});

	return authInstance;
}
