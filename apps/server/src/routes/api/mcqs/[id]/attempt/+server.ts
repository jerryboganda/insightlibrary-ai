import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { mcqs, mcqAttempts } from '$lib/server/db/schema';

const attemptSchema = z.strictObject({
	optionId: z.string().min(1).max(40)
});

/**
 * POST /api/mcqs/[id]/attempt { optionId } — grade an answer server-side and
 * record the attempt (B13). The correct answer and explanation are revealed
 * ONLY here, after the learner commits to a choice — the list endpoint never
 * ships them to non-editors. Returns the verdict plus the learner's updated
 * per-topic rollup so the study page can show real mastery numbers.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const parsed = attemptSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) throw error(400, 'Body must be { optionId }');

	const db = getDb();
	if (!db) throw error(503, 'Database required to record attempts');

	const [mcq] = await db.select().from(mcqs).where(eq(mcqs.id, params.id));
	if (!mcq) throw error(404, 'MCQ not found');
	// Drafts are only attemptable by editors previewing them — for learners a
	// draft does not exist (and must not leak its answer key via this route).
	const editor =
		locals.user?.role === 'editor' || locals.user?.role === 'admin' || locals.user?.role === 'owner';
	if (mcq.status !== 'published' && !editor) throw error(404, 'MCQ not found');

	const option = mcq.options.find((o) => o.id === parsed.data.optionId);
	if (!option) throw error(400, `Unknown option "${parsed.data.optionId}"`);

	const correct = parsed.data.optionId === mcq.correctOptionId;
	const userId = locals.user?.id ?? null;

	await db.insert(mcqAttempts).values({
		id: `mcqa_${randomUUID()}`,
		orgId: mcq.orgId,
		mcqId: mcq.id,
		topicId: mcq.topicId,
		userId,
		chosenOptionId: parsed.data.optionId,
		correct
	});

	// Post-insert rollup for this learner on this topic (topic-wide when anonymous).
	let stats: { attempts: number; correct: number; accuracy: number } | null = null;
	try {
		const where = userId
			? and(eq(mcqAttempts.topicId, mcq.topicId), eq(mcqAttempts.userId, userId))
			: eq(mcqAttempts.topicId, mcq.topicId);
		const [row] = await db
			.select({
				attempts: sql<number>`count(*)::int`,
				correct: sql<number>`coalesce(sum(case when ${mcqAttempts.correct} then 1 else 0 end), 0)::int`
			})
			.from(mcqAttempts)
			.where(where);
		const attempts = row?.attempts ?? 0;
		const correctCount = row?.correct ?? 0;
		stats = { attempts, correct: correctCount, accuracy: attempts ? correctCount / attempts : 0 };
	} catch {
		// Rollup is best-effort; the verdict below is what matters.
	}

	return json({
		correct,
		correctOptionId: mcq.correctOptionId,
		explanation: mcq.explanation,
		stats
	});
};
