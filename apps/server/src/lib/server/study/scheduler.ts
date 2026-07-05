/**
 * Spaced-repetition scheduler (SM-2). Grades map Again/Hard/Good/Easy → 1..4.
 * Produces the next SR state written onto the flashcards SR columns.
 */
export interface SrInput {
	intervalDays?: number | null;
	easeFactor?: number | null;
	repetitions?: number | null;
	lapses?: number | null;
}

export interface SrState {
	intervalDays: number;
	easeFactor: number;
	repetitions: number;
	lapses: number;
	state: 'new' | 'learning' | 'review' | 'relearning';
	dueAt: Date;
}

/** grade: 1 Again · 2 Hard · 3 Good · 4 Easy. */
export function scheduleSm2(prev: SrInput, grade: 1 | 2 | 3 | 4): SrState {
	const q = grade + 1; // → SM-2 quality 2..5
	let ef = prev.easeFactor ?? 2.5;
	let reps = prev.repetitions ?? 0;
	let interval = prev.intervalDays ?? 0;
	let lapses = prev.lapses ?? 0;
	let state: SrState['state'];

	if (q < 3) {
		reps = 0;
		interval = 1;
		lapses += 1;
		state = 'relearning';
	} else {
		ef = Math.max(1.3, ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
		reps += 1;
		if (reps === 1) interval = 1;
		else if (reps === 2) interval = 6;
		else interval = Math.round(interval * ef);
		state = reps <= 1 ? 'learning' : 'review';
	}

	const dueAt = new Date();
	dueAt.setDate(dueAt.getDate() + Math.max(1, interval));
	return { intervalDays: interval, easeFactor: ef, repetitions: reps, lapses, state, dueAt };
}
