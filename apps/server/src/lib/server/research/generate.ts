/**
 * Research suite seeding + report generation (gap B10).
 *
 * Honesty rules that govern this file:
 *  - SEEDING pulls ONLY real, org-scoped data (the source registry, topic claims).
 *    Where nothing real exists we return an empty document, never fabricated
 *    mockup rows like the old prototype's "Book A/B/D" columns.
 *  - REPORT GENERATION runs through the per-org provider router (getRouter(orgId),
 *    task 'synthesis') grounded strictly in the selected sources' first-class
 *    claims. When no provider is configured OR no evidence exists we return an
 *    honest status the UI can show — we never emit a plausible-looking fake draft.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db/client';
import { claims, claimSources, sources } from '../db/schema';
import { getRouter } from '../ai/providers';
import type { CompareMatrixData, ReportData, ReportSource } from './store';

// ── Compare-matrix seeding ───────────────────────────────────────────────────

/**
 * Seed a compare-matrix's columns from the org's registered sources (A5). Rows
 * start empty — the editor fills concept rows and cells. Returns empty columns
 * when the registry is empty (honest: no invented "Book A/B/D").
 */
export async function seedCompareMatrix(orgId: string): Promise<CompareMatrixData> {
	const db = getDb();
	if (!db) return { columns: [], rows: [] };
	const rows = await db
		.select({ name: sources.name })
		.from(sources)
		.where(eq(sources.orgId, orgId));
	const columns = rows.map((r) => r.name).slice(0, 8);
	return { columns, rows: [] };
}

// ── Report generation ────────────────────────────────────────────────────────

export interface ReportGenResult {
	ok: boolean;
	/** How the body was produced — surfaced verbatim by the report page. */
	generatedBy: 'ai' | 'fallback';
	body: string;
	wordCount: number;
	citationCount: number;
	reason?: string;
}

const REPORT_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		title: { type: 'string' },
		markdown: {
			type: 'string',
			description:
				'The full report body in Markdown. Every factual sentence MUST carry an inline citation token in square brackets drawn ONLY from the provided evidence (e.g. [c3]).'
		}
	},
	required: ['title', 'markdown']
};

interface EvidenceLine {
	id: string;
	text: string;
	type: string;
	citation: string;
}

/** Gather first-class claims for the report's SSOT-topic sources (grounding). */
async function gatherEvidence(orgId: string, srcs: ReportSource[]): Promise<EvidenceLine[]> {
	const db = getDb();
	if (!db) return [];
	const topicIds = srcs.map((s) => s.topicId).filter((t): t is string => !!t);
	if (!topicIds.length) return [];

	const claimRows = await db
		.select()
		.from(claims)
		.where(and(inArray(claims.topicId, topicIds), inArray(claims.status, ['active', 'conflicted'])));
	if (!claimRows.length) return [];

	const ids = claimRows.map((c) => c.id);
	const srcRows = ids.length
		? await db.select().from(claimSources).where(inArray(claimSources.claimId, ids))
		: [];
	const citationByClaim = new Map<string, string>();
	for (const s of srcRows) {
		if (citationByClaim.has(s.claimId)) continue;
		const ref = s.sourceRef ?? s.documentId ?? 'src';
		citationByClaim.set(s.claimId, s.locator ? `${ref} ${s.locator}` : ref);
	}

	return claimRows.map((c) => ({
		id: c.jsonbClaimId || c.id,
		text: c.claimText,
		type: c.claimType,
		citation: citationByClaim.get(c.id) ?? 'uncited'
	}));
}

function countWords(md: string): number {
	const words = md.trim().match(/\S+/g);
	return words ? words.length : 0;
}

/** Count distinct inline [token] citations in the generated markdown. */
function countCitations(md: string): number {
	const set = new Set<string>();
	for (const m of md.matchAll(/\[([^\]]{1,40})\]/g)) set.add(m[1].trim());
	return set.size;
}

/**
 * Generate a cited synthesis report for a report project. Grounds the model
 * strictly in the selected topics' claims via the 'synthesis' task. Falls back
 * to a deterministic evidence digest when no provider is configured. Returns an
 * honest failure (ok:false) when there is no evidence to synthesize from.
 */
export async function generateReport(
	orgId: string,
	data: ReportData,
	userId?: string | null
): Promise<ReportGenResult> {
	const evidence = await gatherEvidence(orgId, data.sources ?? []);

	if (!evidence.length) {
		return {
			ok: false,
			generatedBy: 'fallback',
			body: '',
			wordCount: 0,
			citationCount: 0,
			reason:
				'No SSOT evidence is linked to this report. Add an SSOT topic as an evidence source (its claims ground the synthesis), then generate again.'
		};
	}

	const router = getRouter(orgId);
	const evidenceBlock = evidence.map((e) => `[${e.id}] (${e.type}) ${e.text} — cite: ${e.citation}`).join('\n');
	const strictLine = data.strictCitation
		? 'STRICT CITATION MODE: every sentence must cite at least one evidence id in square brackets, and you must introduce NO facts absent from the evidence.'
		: 'Cite evidence ids in square brackets wherever a sentence draws on them.';

	if (await router.availableAsync('synthesis', { orgId })) {
		const res = await router
			.json<{ title: string; markdown: string }>(
				[
					{
						role: 'user',
						content:
							`Write a formal, well-structured research synthesis in Markdown for the following goal, using ONLY the evidence claims provided.\n\n` +
							`GOAL:\n${data.prompt || 'Synthesize the linked evidence into a coherent report.'}\n\n` +
							`${strictLine}\n\nEVIDENCE:\n${evidenceBlock}\n\nReturn JSON per schema.`
					}
				],
				{ task: 'synthesis', schema: REPORT_SCHEMA, temperature: 0.3, ctx: { orgId, userId: userId ?? undefined } }
			)
			.catch(() => null);

		if (res?.markdown?.trim()) {
			const title = res.title?.trim();
			const body = title ? `# ${title}\n\n${res.markdown.trim()}` : res.markdown.trim();
			return {
				ok: true,
				generatedBy: 'ai',
				body,
				wordCount: countWords(body),
				citationCount: countCitations(body)
			};
		}
	}

	// Deterministic evidence-only fallback: a cited digest grouped by claim type.
	const byType = new Map<string, EvidenceLine[]>();
	for (const e of evidence) {
		const list = byType.get(e.type) ?? [];
		list.push(e);
		byType.set(e.type, list);
	}
	const lines: string[] = ['# Evidence Synthesis (draft)', ''];
	if (data.prompt.trim()) lines.push(`> ${data.prompt.trim()}`, '');
	lines.push(
		'_Generated without an AI provider — this is a deterministic digest of the linked evidence. Configure a provider in Settings → AI to synthesize prose._',
		''
	);
	for (const [type, es] of byType) {
		lines.push(`## ${type.charAt(0).toUpperCase()}${type.slice(1)}`, '');
		for (const e of es) lines.push(`- ${e.text} [${e.id}]`);
		lines.push('');
	}
	const body = lines.join('\n');
	return {
		ok: true,
		generatedBy: 'fallback',
		body,
		wordCount: countWords(body),
		citationCount: countCitations(body)
	};
}
