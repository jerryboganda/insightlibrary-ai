import { describe, it, expect } from 'vitest';
import {
	folderSchema,
	documentSchema,
	newClaimSchema,
	searchResponseSchema,
	healthResponseSchema,
	copilotRequestSchema
} from '@insightlibrary/schemas';

describe('schemas (API contract)', () => {
	it('accepts a valid folder and rejects an out-of-range health', () => {
		expect(folderSchema.safeParse({ id: 'f1', name: 'A', docs: 1, topics: 2, health: 90, lastUpdated: 'now' }).success).toBe(true);
		expect(folderSchema.safeParse({ id: 'f1', name: 'A', docs: 1, topics: 2, health: 900, lastUpdated: 'now' }).success).toBe(false);
	});

	it('enforces the document status + type enums', () => {
		const base = { id: 'd', folderId: 'f', title: 'T', statusLabel: 'Indexed', pages: 1, topics: 0, uploadedAt: '2024-01-01' };
		expect(documentSchema.safeParse({ ...base, status: 'indexed', type: 'pdf' }).success).toBe(true);
		expect(documentSchema.safeParse({ ...base, status: 'bogus', type: 'pdf' }).success).toBe(false);
		expect(documentSchema.safeParse({ ...base, status: 'indexed', type: 'mp3' }).success).toBe(false);
	});

	it('requires claim content to be non-empty', () => {
		expect(newClaimSchema.safeParse({ sectionId: 's1', content: 'x', citations: [] }).success).toBe(true);
		expect(newClaimSchema.safeParse({ sectionId: 's1', content: '', citations: [] }).success).toBe(false);
	});

	it('validates a search response envelope', () => {
		const ok = searchResponseSchema.safeParse({
			query: 'cortisol',
			results: [{ kind: 'chunk', id: 'c1', title: 't', snippet: 's', href: '/x', score: 0.5 }],
			total: 1,
			mode: 'hybrid'
		});
		expect(ok.success).toBe(true);
		expect(searchResponseSchema.safeParse({ query: 'x', results: [], total: 0, mode: 'nope' }).success).toBe(false);
	});

	it('constrains the copilot mode enum', () => {
		expect(copilotRequestSchema.safeParse({ mode: 'strict_citation', message: 'hi' }).success).toBe(true);
		expect(copilotRequestSchema.safeParse({ mode: 'freestyle', message: 'hi' }).success).toBe(false);
	});

	it('validates the health response shape', () => {
		expect(
			healthResponseSchema.safeParse({
				status: 'ok',
				service: 's',
				version: '0.1.0',
				dataSource: 'memory',
				time: new Date().toISOString()
			}).success
		).toBe(true);
	});
});
