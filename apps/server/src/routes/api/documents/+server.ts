import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { getRepository } from '$lib/server/data';
import { enqueueIngestion } from '$lib/server/jobs/ingestion';

export const GET: RequestHandler = async ({ url }) => {
	const folderId = url.searchParams.get('folderId') ?? undefined;
	const items = await getRepository().listDocuments(folderId);
	return json({ items, total: items.length });
};

const createSchema = z.object({
	folderId: z.string(),
	title: z.string().min(1),
	type: z.enum(['pdf', 'docx', 'epub']),
	pages: z.number().int().nonnegative().default(0),
	storageKey: z.string().optional(),
	/** Extracted text, when the client already has it (enables real indexing). */
	content: z.string().optional()
});

export const POST: RequestHandler = async ({ request }) => {
	const parsed = createSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) throw error(400, 'Invalid document payload');
	const { content, storageKey, ...meta } = parsed.data;
	const doc = await getRepository().createDocument({ ...meta, storageKey });
	// Kick off the ingestion pipeline: download from S3 → extract → chunk →
	// embed → index. `content` short-circuits the download when text is provided.
	await enqueueIngestion({
		documentId: doc.id,
		documentTitle: doc.title,
		text: content,
		storageKey
	});
	return json(doc, { status: 201 });
};
