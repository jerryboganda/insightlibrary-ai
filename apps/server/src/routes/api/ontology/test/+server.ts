import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { linkMention } from '$lib/server/ontology/link';

const testSchema = z.strictObject({
	/** Sample document text to run entity linking over. */
	text: z.string().trim().min(1).max(20_000),
	/** Optional explicit mentions; when omitted, candidates are derived from text. */
	mentions: z.array(z.string().trim().min(1).max(200)).max(50).optional()
});

/**
 * Candidate mentions from free text: capitalized multi/single-word phrases
 * (proper-noun-ish spans) plus any explicit mentions. Deduped, order-preserved,
 * capped. This is a lightweight surface extractor for the editor's "Run Test" —
 * linkMention() then decides what each actually resolves to (exact synonym match
 * or embedding NN), so nothing is faked.
 */
function candidateMentions(text: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const add = (m: string) => {
		const c = m.trim().replace(/[.,;:!?()"']+$/g, '').replace(/^["'(]+/, '').trim();
		const key = c.toLowerCase();
		if (c.length >= 3 && !seen.has(key)) {
			seen.add(key);
			out.push(c);
		}
	};

	// Capitalized spans, allowing internal lowercase connectors (e.g. "Addison's
	// disease", "adrenal crisis" when it follows a capital). Falls back below.
	const phraseRe = /\b([A-Z][A-Za-z0-9'-]*(?:\s+(?:[A-Z][A-Za-z0-9'-]*|of|and|the|[a-z][a-z-]+)){0,3})/g;
	for (const m of text.matchAll(phraseRe)) add(m[1]);

	// Also consider standalone significant lowercase words (>=5 chars) so a plain
	// term list ("hyperthyroidism") still produces candidates.
	if (out.length < 8) {
		for (const w of text.split(/[^A-Za-z0-9'-]+/)) {
			if (w.length >= 6 && /[a-z]/.test(w)) add(w);
			if (out.length >= 20) break;
		}
	}
	return out.slice(0, 25);
}

/**
 * POST /api/ontology/test (B23) — run a real ontology linking pass over sample
 * text and return what each mention resolves to (concept id, preferred label,
 * ontology, score, match type). Replaces the editor's hardcoded "Simulated JSON
 * Output" with genuine linkMention() results. Read-level (any signed-in user).
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const orgId = locals.user?.orgId || 'org_1';

	const parsed = testSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		throw error(400, `Invalid test body${first ? `: ${first.path.join('.')} ${first.message}` : ''}`);
	}

	const mentions = (parsed.data.mentions?.length ? parsed.data.mentions : candidateMentions(parsed.data.text)).slice(0, 25);

	const results = await Promise.all(
		mentions.map(async (mention) => {
			const link = await linkMention(mention, orgId).catch(() => null);
			if (!link) return { mention, linked: false as const };
			return {
				mention,
				linked: true as const,
				conceptId: link.conceptId,
				prefLabel: link.prefLabel,
				ontology: link.ontology,
				score: Number(link.score.toFixed(4)),
				// score of exactly 1 comes from an exact pref-label/synonym hit.
				match: link.score >= 1 ? ('exact' as const) : ('semantic' as const)
			};
		})
	);

	const entities = results.filter((r): r is Extract<typeof r, { linked: true }> => r.linked);
	return json({
		mentionsTested: mentions.length,
		linkedCount: entities.length,
		entities,
		unmatched: results.filter((r) => !r.linked).map((r) => r.mention)
	});
};
