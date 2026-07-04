import { describe, it, expect } from 'vitest';
import { chunkText, EMBEDDING_DIMS } from './embeddings';

describe('chunkText', () => {
	it('returns no chunks for empty/whitespace text', () => {
		expect(chunkText('')).toEqual([]);
		expect(chunkText('   \n\t ')).toEqual([]);
	});

	it('keeps short text as a single chunk', () => {
		const chunks = chunkText('A short claim about the adrenal cortex.');
		expect(chunks.length).toBe(1);
		expect(chunks[0]).toContain('adrenal cortex');
	});

	it('splits long text into multiple bounded, overlapping chunks', () => {
		const sentence = 'The adrenal cortex secretes cortisol under ACTH control. ';
		const long = sentence.repeat(60); // ~3300 chars
		const chunks = chunkText(long, 800, 120);
		expect(chunks.length).toBeGreaterThan(3);
		// No chunk wildly exceeds the target window.
		expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(900);
		// Reassembled coverage — every chunk is non-empty.
		expect(chunks.every((c) => c.trim().length > 0)).toBe(true);
	});

	it('terminates (no infinite loop) even when overlap >= step (regression)', () => {
		// Pathological params where end-overlap would not advance start.
		for (const [target, overlap] of [
			[200, 50],
			[100, 120],
			[120, 120],
			[300, 300]
		] as const) {
			const chunks = chunkText('word '.repeat(400), target, overlap);
			expect(chunks.length).toBeGreaterThan(0);
			expect(chunks.length).toBeLessThan(5000); // bounded — no runaway
		}
	});

	it('exposes the embedding dimensionality matching the pgvector column', () => {
		expect(EMBEDDING_DIMS).toBe(768);
	});
});
