import { json, error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { presignGetUrl, downloadObject, isStorageConfigured } from '$lib/server/storage/s3';

/**
 * GET /api/documents/[id]/download — serve the original uploaded file
 * (gap B8, "View Source File"). Uploads go directly to S3/MinIO via presigned
 * PUT (documents.storage_key), so:
 *  - default: 302-redirect to a presigned GET URL (signed against the
 *    browser-reachable endpoint, same convention as the upload presign route)
 *  - ?stream=1: proxy the bytes through this server (for deployments whose
 *    S3 endpoint is internal-only)
 *  - honest failures: 404 when no source file was ever stored, 503 when
 *    object storage isn't configured.
 */

const CONTENT_TYPES: Record<string, string> = {
	pdf: 'application/pdf',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	epub: 'application/epub+zip'
};

export const GET: RequestHandler = async ({ params, url }) => {
	const db = getDb();
	if (!db) throw error(404, 'No source file stored for this document (memory mode)');

	const res = await db.execute<{ storage_key: string | null; title: string; type: string }>(
		sql`SELECT storage_key, title, type FROM documents WHERE id = ${params.id}`
	);
	const doc = res.rows[0];
	if (!doc) throw error(404, 'Document not found');
	if (!doc.storage_key) throw error(404, 'No source file stored for this document');
	if (!isStorageConfigured()) {
		throw error(503, 'Object storage is not configured (set S3_* env) — the source file cannot be served');
	}

	const ext = doc.type && CONTENT_TYPES[doc.type] ? `.${doc.type}` : '';
	const baseName = doc.title.replace(/[^\w .()-]+/g, '_').slice(0, 120) || params.id;
	const filename = baseName.toLowerCase().endsWith(ext) || !ext ? baseName : `${baseName}${ext}`;

	if (url.searchParams.get('stream') === '1') {
		const bytes = await downloadObject(doc.storage_key);
		if (!bytes) throw error(502, 'Failed to fetch the source file from object storage');
		return new Response(new Uint8Array(bytes), {
			headers: {
				'Content-Type': CONTENT_TYPES[doc.type] ?? 'application/octet-stream',
				'Content-Length': String(bytes.byteLength),
				'Content-Disposition': `inline; filename="${filename.replace(/["\\\r\n]/g, '_')}"`
			}
		});
	}

	const signed = await presignGetUrl(doc.storage_key, { filename });
	if (!signed) throw error(503, 'Object storage is not configured — the source file cannot be served');
	// JSON mode for programmatic callers (api-client); redirect for browser tabs.
	if (url.searchParams.get('format') === 'json') return json({ url: signed, expiresIn: 900 });
	throw redirect(302, signed);
};
