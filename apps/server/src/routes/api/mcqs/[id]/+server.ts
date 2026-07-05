import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { requireRole } from '$lib/server/auth-guard';
import { getDb } from '$lib/server/db/client';
import { mcqs } from '$lib/server/db/schema';

const patchSchema = z.strictObject({
	status: z.enum(['draft', 'published'])
});

/**
 * PATCH /api/mcqs/[id] { status } — publish or unpublish an MCQ (editor+).
 * The review gate for AI-generated questions (C9): when the org's
 * requireReview governance setting is on, generation inserts drafts and this
 * endpoint is how an editor releases them to learners (GET /api/mcqs only
 * serves published items to non-editors).
 */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	requireRole(locals.user, 'editor');

	const parsed = patchSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) throw error(400, 'Body must be { status: "draft" | "published" }');

	const db = getDb();
	if (!db) throw error(503, 'Database required to update MCQs');

	const [row] = await db
		.update(mcqs)
		.set({ status: parsed.data.status })
		.where(eq(mcqs.id, params.id))
		.returning();
	if (!row) throw error(404, 'MCQ not found');

	return json({
		item: {
			id: row.id,
			topicId: row.topicId,
			claimId: row.claimId,
			stem: row.stem,
			options: row.options,
			correctOptionId: row.correctOptionId,
			explanation: row.explanation,
			difficulty: row.difficulty,
			examTags: row.examTags,
			status: row.status
		}
	});
};
