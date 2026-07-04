import { describe, it, expect } from 'vitest';
import { InMemoryRepository } from './repository';
import {
	seedAudit,
	seedCoverage,
	seedDelta,
	seedDocuments,
	seedEvaluation,
	seedFlashcards,
	seedFolders,
	seedGraph,
	seedNotifications,
	seedOntologies,
	seedProcessing,
	seedReview,
	seedSources,
	seedTopics,
	seedUsage,
	seedUsers
} from './seed';

function makeRepo() {
	return new InMemoryRepository({
		folders: structuredClone(seedFolders),
		documents: structuredClone(seedDocuments),
		sources: structuredClone(seedSources),
		topics: structuredClone(seedTopics),
		coverage: structuredClone(seedCoverage),
		delta: structuredClone(seedDelta),
		flashcards: structuredClone(seedFlashcards),
		graph: structuredClone(seedGraph),
		review: structuredClone(seedReview),
		usage: structuredClone(seedUsage),
		evaluation: structuredClone(seedEvaluation),
		processing: structuredClone(seedProcessing),
		audit: structuredClone(seedAudit),
		ontologies: structuredClone(seedOntologies),
		users: structuredClone(seedUsers),
		notifications: structuredClone(seedNotifications)
	});
}

describe('InMemoryRepository', () => {
	it('lists folders and creates new ones', async () => {
		const repo = makeRepo();
		const before = await repo.listFolders();
		expect(before.length).toBe(3);
		const created = await repo.createFolder({ name: 'Cardiology' });
		expect(created.name).toBe('Cardiology');
		expect(created.health).toBe(100);
		expect((await repo.listFolders()).length).toBe(4);
	});

	it('does not leak internal state (returns clones)', async () => {
		const repo = makeRepo();
		const a = await repo.listFolders();
		a[0].name = 'MUTATED';
		const b = await repo.listFolders();
		expect(b[0].name).not.toBe('MUTATED');
	});

	it('strips heavy sections from the topic list but keeps them on detail', async () => {
		const repo = makeRepo();
		const list = await repo.listTopics();
		expect(list.every((t) => t.sections === undefined)).toBe(true);
		const detail = await repo.getTopic('addisons-disease');
		expect(detail?.sections?.length).toBeGreaterThan(0);
	});

	it('persists a new claim into an SSOT section', async () => {
		const repo = makeRepo();
		const before = (await repo.getTopic('addisons-disease'))!.sections!.find((s) => s.id === 's3')!;
		const n = before.claims.length;
		const claim = await repo.addClaim('addisons-disease', {
			sectionId: 's3',
			content: 'Stress-dose steroids during intercurrent illness.',
			citations: ['bk-B', 'p57']
		});
		expect(claim).not.toBeNull();
		const after = (await repo.getTopic('addisons-disease'))!.sections!.find((s) => s.id === 's3')!;
		expect(after.claims.length).toBe(n + 1);
		expect(after.claims.at(-1)!.content).toContain('Stress-dose');
	});

	it('returns null when adding a claim to a missing section', async () => {
		const repo = makeRepo();
		expect(await repo.addClaim('addisons-disease', { sectionId: 'nope', content: 'x', citations: [] })).toBeNull();
	});

	it('resolves review items', async () => {
		const repo = makeRepo();
		const resolved = await repo.resolveReview('r1', 'accepted');
		expect(resolved?.status).toBe('accepted');
	});

	it('marks all notifications read', async () => {
		const repo = makeRepo();
		await repo.markAllNotificationsRead();
		expect((await repo.listNotifications()).every((n) => n.read)).toBe(true);
	});
});

describe('InMemoryRepository.search', () => {
	it('returns empty for a blank query', async () => {
		const { results, mode } = await makeRepo().search('   ');
		expect(results).toEqual([]);
		expect(mode).toBe('text');
	});

	it('finds a topic by name and its claims as chunk hits', async () => {
		const { results } = await makeRepo().search('cortisol');
		expect(results.length).toBeGreaterThan(0);
		// The Physiology claim about cortisol should surface as a chunk.
		expect(results.some((r) => r.kind === 'chunk' && /cortisol/i.test(r.snippet))).toBe(true);
	});

	it('matches documents by title', async () => {
		const { results } = await makeRepo().search('pathoma');
		expect(results.some((r) => r.kind === 'document' && /Pathoma/i.test(r.title))).toBe(true);
	});

	it('ranks topic matches above chunk/document matches', async () => {
		const { results } = await makeRepo().search('addison');
		const topic = results.find((r) => r.kind === 'topic');
		expect(topic).toBeDefined();
		expect(topic!.score).toBeGreaterThanOrEqual(Math.max(...results.map((r) => r.score)));
	});
});
