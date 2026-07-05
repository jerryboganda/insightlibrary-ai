import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { SessionUser } from '@insightlibrary/schemas';
import { getDb, type Db } from '$lib/server/db/client';
import { mcqs, mcqAttempts } from '$lib/server/db/schema';
import { generateMcqsForTopic } from '$lib/server/refinery/mcq';

/** Editors and above may see drafts and correct answers in list payloads. */
function isEditor(user: SessionUser | null): boolean {
	return user?.role === 'editor' || user?.role === 'admin' || user?.role === 'owner';
}

/**
 * Per-topic attempt rollup for the study page's mastery/weakness stats.
 * Scoped to the signed-in learner when a user id exists (personal mastery),
 * otherwise topic-wide. Best-effort: returns null if the table is missing.
 */
async function topicAttemptStats(
	db: Db,
	topicId: string,
	userId?: string
): Promise<{ attempts: number; correct: number; accuracy: number } | null> {
	try {
		const where = userId
			? and(eq(mcqAttempts.topicId, topicId), eq(mcqAttempts.userId, userId))
			: eq(mcqAttempts.topicId, topicId);
		const [row] = await db
			.select({
				attempts: sql<number>`count(*)::int`,
				correct: sql<number>`coalesce(sum(case when ${mcqAttempts.correct} then 1 else 0 end), 0)::int`
			})
			.from(mcqAttempts)
			.where(where);
		const attempts = row?.attempts ?? 0;
		const correct = row?.correct ?? 0;
		return { attempts, correct, accuracy: attempts ? correct / attempts : 0 };
	} catch (e) {
		// mcq_attempts not migrated yet — stats simply unavailable, never a 500.
		console.error('[mcqs] attempt stats failed:', e instanceof Error ? e.message : e);
		return null;
	}
}

/**
 * GET /api/mcqs?topicId=&status= — list MCQs (optionally by topic).
 *
 * Answer-leak guard (B13): correctOptionId/explanation are stripped for
 * non-editors — grading happens server-side in POST /api/mcqs/[id]/attempt.
 * Draft gate (C9): non-editors only ever see status='published'; editors may
 * pass ?status=draft|published|all to review the generation queue.
 * When topicId is given, `stats` carries the learner's attempt rollup.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	const topicId = url.searchParams.get('topicId');
	const editor = isEditor(locals.user);

	const requested = url.searchParams.get('status');
	// Non-editors are pinned to published no matter what they ask for.
	const status = editor && (requested === 'draft' || requested === 'all') ? requested : 'published';

	const db = getDb();
	if (!db) return json({ items: [], total: 0, stats: null });

	const conditions: SQL[] = [];
	if (topicId) conditions.push(eq(mcqs.topicId, topicId));
	if (status !== 'all') conditions.push(eq(mcqs.status, status));
	const rows = conditions.length
		? await db.select().from(mcqs).where(and(...conditions))
		: await db.select().from(mcqs);

	const items = rows.map((r) => ({
		id: r.id,
		topicId: r.topicId,
		claimId: r.claimId,
		stem: r.stem,
		options: r.options,
		difficulty: r.difficulty,
		examTags: r.examTags,
		status: r.status,
		// Editors keep the answer key (needed to review drafts); learners never
		// receive it — the attempt endpoint reveals it after answering.
		...(editor ? { correctOptionId: r.correctOptionId, explanation: r.explanation } : {})
	}));

	const stats = topicId ? await topicAttemptStats(db, topicId, locals.user?.id) : null;
	return json({ items, total: items.length, stats });
};

/** POST /api/mcqs { topicId, count? } — generate MCQs from the topic's claims. */
export const POST: RequestHandler = async ({ request, locals }) => {
	const body = (await request.json().catch(() => null)) as { topicId?: string; count?: number } | null;
	if (!body?.topicId) throw error(400, 'topicId required');
	const res = await generateMcqsForTopic(body.topicId, locals.user?.orgId || 'org_1', body.count ?? 5);
	return json(res);
};
