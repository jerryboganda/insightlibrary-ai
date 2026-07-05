import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sql, type SQL } from 'drizzle-orm';
import { getDb, type Db } from '$lib/server/db/client';
import { getRepository } from '$lib/server/data';
import { requireRole } from '$lib/server/auth-guard';
import { bucketUsage, isStorageConfigured } from '$lib/server/storage/s3';

/**
 * GET /api/admin/storage-stats — real storage numbers (gap C7), replacing the
 * invented "142 GB / 1.2M nodes / 8.4 TB" capacity cards:
 *  - database: pg_database_size + per-table pg_total_relation_size
 *  - counts: org-scoped documents/chunks/embedded chunks/doc_blocks and
 *    graph nodes/edges (+claims when migrated)
 *  - s3: aggregate object count/bytes under the org's tenant prefix via
 *    ListObjectsV2 (cached ~5 min in storage/s3.ts)
 * Degrades honestly: memory mode and unconfigured S3 return nulls, never fakes.
 */

async function count(db: Db, q: SQL): Promise<number | null> {
	try {
		const res = await db.execute<{ n: number }>(q);
		return Number(res.rows[0]?.n ?? 0);
	} catch {
		return null; // table not migrated on this deployment
	}
}

async function relationSize(db: Db, table: string): Promise<number | null> {
	try {
		const res = await db.execute<{ bytes: number }>(
			sql`SELECT pg_total_relation_size(${table}::regclass)::bigint AS bytes`
		);
		return Number(res.rows[0]?.bytes ?? 0);
	} catch {
		return null;
	}
}

export const GET: RequestHandler = async ({ locals }) => {
	const user = requireRole(locals.user, 'admin');
	const orgId = user.orgId || 'org_1';
	const db = getDb();

	// ── S3 usage under the org's upload prefix (same prefix presign writes to) ─
	const tenant = user.tenantId || 'public';
	let s3: {
		configured: boolean;
		prefix: string | null;
		bytes: number | null;
		objects: number | null;
		truncated: boolean;
		cachedAt: string | null;
	} = { configured: false, prefix: null, bytes: null, objects: null, truncated: false, cachedAt: null };
	if (isStorageConfigured()) {
		const usage = await bucketUsage(`${tenant}/`).catch(() => null);
		s3 = {
			configured: true,
			prefix: `${tenant}/`,
			bytes: usage?.bytes ?? null,
			objects: usage?.objects ?? null,
			truncated: usage?.truncated ?? false,
			cachedAt: usage?.cachedAt ?? null
		};
	}

	// ── Memory mode: honest seed counts, no DB sizes ───────────────────────────
	if (!db) {
		const repo = getRepository();
		const docs = await repo.listDocuments();
		return json({
			source: 'memory',
			database: null,
			counts: {
				documents: docs.length,
				chunks: null,
				embeddedChunks: null,
				docBlocks: null,
				graphNodes: null,
				graphEdges: null,
				claims: null
			},
			s3
		});
	}

	// ── Org-scoped counts ──────────────────────────────────────────────────────
	const [documents, chunks, embeddedChunks, docBlocks, graphNodes, graphEdges, claims] =
		await Promise.all([
			count(db, sql`SELECT COUNT(*)::int AS n FROM documents d JOIN folders f ON f.id = d.folder_id WHERE f.org_id = ${orgId}`),
			count(db, sql`SELECT COUNT(*)::int AS n FROM chunks c JOIN documents d ON d.id = c.document_id JOIN folders f ON f.id = d.folder_id WHERE f.org_id = ${orgId}`),
			count(db, sql`SELECT COUNT(*)::int AS n FROM chunks c JOIN documents d ON d.id = c.document_id JOIN folders f ON f.id = d.folder_id WHERE f.org_id = ${orgId} AND c.embedding IS NOT NULL`),
			count(db, sql`SELECT COUNT(*)::int AS n FROM doc_blocks b JOIN documents d ON d.id = b.document_id JOIN folders f ON f.id = d.folder_id WHERE f.org_id = ${orgId}`),
			count(db, sql`SELECT COUNT(*)::int AS n FROM graph_nodes WHERE org_id = ${orgId}`),
			count(db, sql`SELECT COUNT(*)::int AS n FROM graph_edges WHERE org_id = ${orgId}`),
			count(db, sql`SELECT COUNT(*)::int AS n FROM claims WHERE org_id = ${orgId}`)
		]);

	// ── Physical sizes (global — Postgres has no per-org relation sizes) ──────
	let databaseBytes: number | null = null;
	try {
		const res = await db.execute<{ bytes: number }>(
			sql`SELECT pg_database_size(current_database())::bigint AS bytes`
		);
		databaseBytes = Number(res.rows[0]?.bytes ?? 0);
	} catch {
		databaseBytes = null;
	}
	const [chunksBytes, docBlocksBytes, graphNodesBytes, graphEdgesBytes, claimsBytes] =
		await Promise.all([
			relationSize(db, 'chunks'),
			relationSize(db, 'doc_blocks'),
			relationSize(db, 'graph_nodes'),
			relationSize(db, 'graph_edges'),
			relationSize(db, 'claims')
		]);

	return json({
		source: 'postgres',
		database: {
			totalBytes: databaseBytes,
			tables: {
				chunks: chunksBytes,
				docBlocks: docBlocksBytes,
				graphNodes: graphNodesBytes,
				graphEdges: graphEdgesBytes,
				claims: claimsBytes
			}
		},
		counts: { documents, chunks, embeddedChunks, docBlocks, graphNodes, graphEdges, claims },
		s3
	});
};
