import { describe, it, expect } from 'vitest';
import { computeCoverage } from './coverage';
import { seedTopics } from './seed';
import type { Topic } from '@insightlibrary/schemas';

describe('computeCoverage', () => {
	it('returns empty for a topic with no sections', () => {
		expect(computeCoverage(null)).toEqual([]);
		expect(computeCoverage({ sections: [] } as unknown as Topic)).toEqual([]);
	});

	it('derives the matrix from real claim citations', () => {
		const addisons = seedTopics.find((t) => t.id === 'addisons-disease')!;
		const rows = computeCoverage(addisons);
		expect(rows.length).toBe(addisons.sections!.length);

		// Anatomy (s1): both claims cite bk-A → Strong for bk-A, None elsewhere.
		const anatomy = rows.find((r) => r.aspect === 'Anatomy')!;
		expect(anatomy.bA).toBe('Strong');
		expect(anatomy.bC).toBe('None');
		expect(anatomy.status).toBe('Covered');

		// Radiology (s4): single claim cites bk-C once → Medium, status Improved.
		const radiology = rows.find((r) => r.aspect === 'Radiology')!;
		expect(radiology.bC).toBe('Medium');
		expect(radiology.bA).toBe('None');
		expect(radiology.status).toBe('Improved');
	});
});
