import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';

/**
 * GET /api/figures?q= — visual/tabular retrieval: search extracted figure &
 * table blocks (doc_blocks) by caption/markdown. The cloud-side substitute for
 * CLIP page-image retrieval ("find the diagram/table").
 */
export const GET: RequestHandler = async ({ url }) => {
	const q = (url.searchParams.get('q') ?? '').trim();
	const db = getDb();
	if (!db) return json({ items: [], total: 0 });
	const like = `%${q}%`;
	const rows = await db.execute<{ id: string; document_id: string; page: number; kind: string; content: string; title: string }>(sql`
		SELECT b.id, b.document_id, b.page_no AS page, b.kind, b.content, d.title
		FROM doc_blocks b JOIN documents d ON d.id = b.document_id
		WHERE b.kind IN ('figure', 'table') ${q ? sql`AND b.content ILIKE ${like}` : sql``}
		ORDER BY b.document_id, b.page_no
		LIMIT 50
	`);
	const items = rows.rows.map((r) => ({
		id: r.id,
		documentId: r.document_id,
		page: r.page,
		kind: r.kind,
		content: r.content,
		title: r.title
	}));
	return json({ items, total: items.length });
};
