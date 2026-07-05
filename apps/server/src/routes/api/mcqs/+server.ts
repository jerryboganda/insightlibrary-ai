import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { mcqs } from '$lib/server/db/schema';
import { generateMcqsForTopic } from '$lib/server/refinery/mcq';

/** GET /api/mcqs?topicId= — list MCQs (optionally by topic). */
export const GET: RequestHandler = async ({ url }) => {
	const topicId = url.searchParams.get('topicId');
	const db = getDb();
	if (!db) return json({ items: [], total: 0 });
	const rows = topicId
		? await db.select().from(mcqs).where(eq(mcqs.topicId, topicId))
		: await db.select().from(mcqs);
	const items = rows.map((r) => ({
		id: r.id,
		topicId: r.topicId,
		claimId: r.claimId,
		stem: r.stem,
		options: r.options,
		correctOptionId: r.correctOptionId,
		explanation: r.explanation,
		difficulty: r.difficulty,
		examTags: r.examTags,
		status: r.status
	}));
	return json({ items, total: items.length });
};

/** POST /api/mcqs { topicId, count? } — generate MCQs from the topic's claims. */
export const POST: RequestHandler = async ({ request, locals }) => {
	const body = (await request.json().catch(() => null)) as { topicId?: string; count?: number } | null;
	if (!body?.topicId) throw error(400, 'topicId required');
	const res = await generateMcqsForTopic(body.topicId, locals.user?.orgId || 'org_1', body.count ?? 5);
	return json(res);
};
