import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isNull, eq, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { chunks } from '$lib/server/db/schema';
import { embedText } from '$lib/server/ai/embeddings';
import { requireRole } from '$lib/server/auth-guard';

/**
 * POST /api/admin/reindex — backfill embeddings for chunks that lack them and
 * (re)build the search indexes. Bounded per call; run repeatedly to finish.
 * (Storage → "Start Rebuild".)
 */
export const POST: RequestHandler = async ({ locals }) => {
	requireRole(locals.user, 'admin');
	const db = getDb();
	if (!db) throw error(503, 'A database is required');

	const rows = await db.select().from(chunks).where(isNull(chunks.embedding)).limit(500);
	let reembedded = 0;
	for (const c of rows) {
		const emb = await embedText(c.context ? `${c.context}\n${c.content}` : c.content).catch(() => null);
		if (emb) {
			await db.update(chunks).set({ embedding: emb }).where(eq(chunks.id, c.id));
			reembedded++;
		}
	}
	// Ensure the search indexes exist (idempotent).
	await db.execute(
		sql`CREATE INDEX IF NOT EXISTS chunks_weighted_fts_idx ON chunks USING gin (
		    (setweight(to_tsvector('english', coalesce(context, '')), 'A') ||
		     setweight(to_tsvector('english', content), 'B')))`
	);
	return json({ reembedded, remaining: rows.length === 500 });
};
