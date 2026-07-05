import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { eq } from 'drizzle-orm';
import { flashcardGradeSchema } from '@insightlibrary/schemas';
import { getDb } from '$lib/server/db/client';
import { flashcards } from '$lib/server/db/schema';
import { scheduleSm2 } from '$lib/server/study/scheduler';

/** POST /api/flashcards/[id]/review { grade: 1..4 } — grade + reschedule (SM-2). */
export const POST: RequestHandler = async ({ params, request }) => {
	const db = getDb();
	if (!db) throw error(503, 'A database is required for spaced repetition');
	const parsed = flashcardGradeSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) throw error(400, 'grade (1..4) required');

	const [card] = await db.select().from(flashcards).where(eq(flashcards.id, params.id));
	if (!card) throw error(404, 'card not found');

	const next = scheduleSm2(
		{ intervalDays: card.intervalDays, easeFactor: card.easeFactor, repetitions: card.repetitions, lapses: card.lapses },
		parsed.data.grade as 1 | 2 | 3 | 4
	);
	await db
		.update(flashcards)
		.set({
			intervalDays: next.intervalDays,
			easeFactor: next.easeFactor,
			repetitions: next.repetitions,
			lapses: next.lapses,
			state: next.state,
			dueAt: next.dueAt,
			lastReviewedAt: new Date()
		})
		.where(eq(flashcards.id, params.id));

	return json({ ok: true, ...next, dueAt: next.dueAt.toISOString() });
};
