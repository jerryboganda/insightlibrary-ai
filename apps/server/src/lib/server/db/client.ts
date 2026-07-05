/**
 * Lazily-constructed Drizzle client keyed off process.env.DATABASE_URL, so it
 * works in BOTH the SvelteKit runtime and the standalone pg-boss worker. Refinery
 * modules and the credential store use this instead of building their own pool.
 * Returns null when no DATABASE_URL is set (in-memory / mock mode).
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;

let _db: Db | null = null;

export function getDb(): Db | null {
	const url = process.env.DATABASE_URL;
	if (!url) return null;
	if (_db) return _db;
	const pool = new pg.Pool({ connectionString: url });
	_db = drizzle(pool, { schema });
	return _db;
}
