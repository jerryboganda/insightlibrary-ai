import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin, bearer, organization } from 'better-auth/plugins';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './db/schema';

/**
 * Static better-auth instance — kept in its own module (no $env, no SvelteKit
 * imports) so the `@better-auth/cli` can import it to generate/migrate the auth
 * schema:
 *   npx @better-auth/cli migrate --config src/lib/server/auth-config.ts -y
 *
 * Built only when DATABASE_URL is set. Uses process.env so it works both inside
 * the SvelteKit server (adapter-node) and under the CLI. Web clients get cookie
 * sessions; the Tauri client uses the bearer plugin (token in the OS keyring).
 */
function build() {
	const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
	const db = drizzle(pool, { schema });
	return betterAuth({
		secret: process.env.BETTER_AUTH_SECRET,
		baseURL: process.env.BETTER_AUTH_URL,
		database: drizzleAdapter(db, { provider: 'pg' }),
		emailAndPassword: { enabled: true },
		trustedOrigins: process.env.WEB_ORIGIN ? [process.env.WEB_ORIGIN] : [],
		plugins: [organization(), admin(), bearer()]
	});
}

export const auth = process.env.DATABASE_URL ? build() : null;
