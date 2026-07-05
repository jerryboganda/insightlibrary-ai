import { describe, it, expect } from 'vitest';
import { scheduleSm2 } from './scheduler';

describe('scheduleSm2', () => {
	it('first Good review → 1 day, learning', () => {
		const s = scheduleSm2({}, 3);
		expect(s.repetitions).toBe(1);
		expect(s.intervalDays).toBe(1);
		expect(s.state).toBe('learning');
	});

	it('second Good review → 6 days, review', () => {
		const s = scheduleSm2({ repetitions: 1, intervalDays: 1, easeFactor: 2.5 }, 3);
		expect(s.repetitions).toBe(2);
		expect(s.intervalDays).toBe(6);
		expect(s.state).toBe('review');
	});

	it('third Good review multiplies interval by ease factor', () => {
		const s = scheduleSm2({ repetitions: 2, intervalDays: 6, easeFactor: 2.5 }, 3);
		expect(s.repetitions).toBe(3);
		expect(s.intervalDays).toBe(15); // round(6 * 2.5)
	});

	it('Again resets reps, increments lapses, enters relearning', () => {
		const s = scheduleSm2({ repetitions: 5, intervalDays: 30, easeFactor: 2.5, lapses: 1 }, 1);
		expect(s.repetitions).toBe(0);
		expect(s.intervalDays).toBe(1);
		expect(s.lapses).toBe(2);
		expect(s.state).toBe('relearning');
	});

	it('ease factor never drops below 1.3', () => {
		let ef = 1.4;
		for (let i = 0; i < 12; i++) {
			ef = scheduleSm2({ repetitions: 2, intervalDays: 6, easeFactor: ef }, 2).easeFactor;
		}
		expect(ef).toBeGreaterThanOrEqual(1.3);
	});

	it('every card is due at least one day out', () => {
		const s = scheduleSm2({}, 4);
		expect(s.dueAt.getTime()).toBeGreaterThan(Date.now());
	});
});
