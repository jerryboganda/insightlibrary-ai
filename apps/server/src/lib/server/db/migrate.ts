/**
 * Hand-authored, additive migration runner (invoked by `pnpm db:migrate`).
 *
 * The live DB was created with `drizzle-kit push` and has no drizzle journal
 * baseline, so applying a generated full-schema migration would try to recreate
 * existing tables. Instead we keep reviewed, idempotent SQL under
 * apps/server/migrations/*.sql (all statements use IF NOT EXISTS) and apply each
 * once, tracked in _refinery_migrations. Uses process.env so it runs via tsx
 * outside the SvelteKit runtime.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'migrations');

async function main() {
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) {
		console.error('DATABASE_URL is not set — nothing to migrate.');
		process.exit(1);
	}
	const pool = new pg.Pool({ connectionString });
	const client = await pool.connect();
	try {
		await client.query(`CREATE TABLE IF NOT EXISTS _refinery_migrations (
			name text PRIMARY KEY,
			applied_at timestamptz NOT NULL DEFAULT now()
		)`);

		const files = readdirSync(MIGRATIONS_DIR)
			.filter((f) => f.endsWith('.sql'))
			.sort();

		for (const file of files) {
			const { rows } = await client.query('SELECT 1 FROM _refinery_migrations WHERE name = $1', [file]);
			if (rows.length) {
				console.log(`↷ skip   ${file} (already applied)`);
				continue;
			}
			const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
			console.log(`→ apply  ${file}`);
			await client.query('BEGIN');
			try {
				await client.query(sql);
				await client.query('INSERT INTO _refinery_migrations (name) VALUES ($1)', [file]);
				await client.query('COMMIT');
				console.log(`✓ done   ${file}`);
			} catch (e) {
				await client.query('ROLLBACK');
				console.error(`✗ failed ${file}:`, e instanceof Error ? e.message : e);
				throw e;
			}
		}
		console.log('All migrations applied.');
	} finally {
		client.release();
		await pool.end();
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
