import type { CoverageCell, CoverageRow, Topic } from '@insightlibrary/schemas';

/**
 * Derive the source-coverage matrix from a topic's actual SSOT content: for each
 * section (aspect) and each source, count the claims that cite it and grade the
 * density. This replaces the seeded constant with a value computed from the real
 * claims, so it stays accurate as claims are added/removed.
 */
const SOURCES = ['bk-A', 'bk-B', 'bk-C', 'bk-D'] as const;

function grade(count: number): CoverageCell {
	if (count >= 3) return 'Strong';
	if (count === 2) return 'Strong';
	if (count === 1) return 'Medium';
	return 'None';
}

function status(cells: CoverageCell[]): string {
	if (cells.includes('Strong')) return 'Covered';
	if (cells.includes('Medium')) return 'Improved';
	if (cells.some((c) => c !== 'None')) return 'Needs expansion';
	return 'Needs expansion';
}

export function computeCoverage(topic: Topic | null): CoverageRow[] {
	if (!topic?.sections?.length) return [];
	return topic.sections.map((section) => {
		const cells = SOURCES.map((src) =>
			grade(section.claims.filter((c) => c.citations.includes(src)).length)
		);
		const [bA, bB, bC, bD] = cells;
		return { aspect: section.title, bA, bB, bC, bD, status: status(cells) };
	});
}
