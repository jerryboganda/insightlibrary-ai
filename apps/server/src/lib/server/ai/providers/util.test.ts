import { describe, it, expect } from 'vitest';
import { parseJsonLoose, splitSystem } from './util';

describe('parseJsonLoose', () => {
	it('parses plain JSON', () => {
		expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
	});
	it('parses fenced JSON', () => {
		expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
	});
	it('parses JSON embedded in prose via balanced block', () => {
		expect(parseJsonLoose('Here you go: {"a":[1,2]} — done')).toEqual({ a: [1, 2] });
	});
	it('parses top-level arrays', () => {
		expect(parseJsonLoose('[1,2,3]')).toEqual([1, 2, 3]);
	});
	it('throws on non-JSON output', () => {
		expect(() => parseJsonLoose('no json here')).toThrow();
	});
});

describe('splitSystem', () => {
	it('separates system messages and prepends extra', () => {
		const { system, turns } = splitSystem(
			[
				{ role: 'system', content: 'be terse' },
				{ role: 'user', content: 'hi' }
			],
			'extra rule'
		);
		expect(system).toBe('extra rule\n\nbe terse');
		expect(turns).toHaveLength(1);
		expect(turns[0].role).toBe('user');
	});
});
