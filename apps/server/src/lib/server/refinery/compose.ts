/**
 * Evidence-only topic-page composer. Builds the SSOT sections ONLY from the
 * topic's retrieved first-class claims (never from model memory): the provider
 * organizes claims into the canonical section structure with per-sentence
 * citations, the verifier drops any sentence not grounded in a cited claim, and
 * the result is written to topics.sections JSONB + snapshotted as a new
 * topic_version with a faithfulness score. Falls back to a deterministic
 * claim-grouping when no provider is configured (still evidence-only).
 */
import { eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { topics } from '../db/schema';
import { getRouter } from '../ai/providers';
import { retrieveTopicEvidence, type ClaimEvidence } from './retrieve';
import { verifySentences } from './verify';
import { snapshotTopic } from './versioning';

interface OutSection {
	id: string;
	title: string;
	icon: string;
	claims: { id: string; content: string; citations: string[] }[];
}

const COMPOSE_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		sections: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					title: { type: 'string' },
					icon: { type: 'string' },
					sentences: {
						type: 'array',
						items: {
							type: 'object',
							properties: { content: { type: 'string' }, citationClaimIds: { type: 'array', items: { type: 'string' } } },
							required: ['content', 'citationClaimIds']
						}
					}
				},
				required: ['title', 'sentences']
			}
		}
	},
	required: ['sections']
};

const TYPE_TITLES: Record<string, string> = {
	definition: 'Definition',
	mechanism: 'Pathophysiology',
	symptom: 'Clinical features',
	sign: 'Clinical features',
	lab: 'Investigations',
	diagnosis: 'Diagnosis',
	treatment: 'Treatment',
	pharmacology: 'Pharmacology',
	complication: 'Complications',
	differential: 'Differentials',
	exam_pearl: 'High-yield pearls',
	contraindication: 'Contraindications',
	fact: 'Key facts'
};

export interface ComposeResult {
	ok: boolean;
	faithfulness?: number;
	sections?: number;
	claims?: number;
	version?: number | null;
	reason?: string;
}

export async function composeTopic(topicId: string): Promise<ComposeResult> {
	const db = getDb();
	if (!db) return { ok: false, reason: 'no database' };
	const { topicName, evidence } = await retrieveTopicEvidence(topicId);
	if (!evidence.length) return { ok: false, reason: 'no evidence claims for this topic yet' };

	const evidenceById = new Map<string, ClaimEvidence>(evidence.map((e) => [e.id, e]));
	const router = getRouter();
	let sectionsOut: OutSection[] = [];
	let faithfulness = 1;

	if (router.available('synthesis')) {
		const claimList = evidence.map((e) => `[${e.id}] (${e.type}) ${e.text}`).join('\n');
		const res = await router
			.json<{ sections: { title: string; icon?: string; sentences: { content: string; citationClaimIds: string[] }[] }[] }>(
				[
					{
						role: 'user',
						content:
							`Compose an evidence-based medical topic page for "${topicName}" using ONLY the claims below. ` +
							'Organize into sections in this order where evidence exists: Definition, Pathophysiology, Etiology, ' +
							'Clinical features, Investigations, Diagnosis, Treatment, Complications, Differentials, High-yield pearls. ' +
							'Every sentence MUST list the claim ids it is based on in citationClaimIds and introduce NO facts absent from ' +
							`the claims. Use a lucide icon name per section. Return JSON per schema.\n\nCLAIMS:\n${claimList}`
					}
				],
				{ task: 'synthesis', schema: COMPOSE_SCHEMA, temperature: 0.2 }
			)
			.catch(() => null);

		if (res?.sections?.length) {
			let total = 0;
			let okCount = 0;
			let sIdx = 0;
			for (const sec of res.sections) {
				const v = await verifySentences(
					(sec.sentences ?? []).map((x) => ({ content: x.content, citationClaimIds: x.citationClaimIds })),
					evidenceById,
					{ strict: false }
				);
				total += sec.sentences?.length ?? 0;
				okCount += v.supported.length;
				if (!v.supported.length) continue;
				sIdx++;
				sectionsOut.push({
					id: `s${sIdx}`,
					title: sec.title,
					icon: sec.icon ?? 'file-text',
					claims: v.supported.map((sp, i) => ({ id: `s${sIdx}_c${i}`, content: sp.content, citations: sp.citations }))
				});
			}
			faithfulness = total ? okCount / total : 1;
		}
	}

	// Deterministic evidence-only fallback: group retrieved claims by type.
	if (!sectionsOut.length) {
		const byType = new Map<string, ClaimEvidence[]>();
		for (const e of evidence) {
			const list = byType.get(e.type) ?? [];
			list.push(e);
			byType.set(e.type, list);
		}
		let sIdx = 0;
		for (const [type, es] of byType) {
			sIdx++;
			sectionsOut.push({
				id: `s${sIdx}`,
				title: TYPE_TITLES[type] ?? 'Details',
				icon: 'file-text',
				claims: es.map((e, i) => ({ id: `s${sIdx}_c${i}`, content: e.text, citations: e.citations }))
			});
		}
		faithfulness = 1;
	}

	const claimCount = sectionsOut.reduce((n, s) => n + s.claims.length, 0);
	await db
		.update(topics)
		.set({ sections: sectionsOut, updatedAt: new Date(), updates: sql`${topics.updates} + 1`, health: Math.round(faithfulness * 100) })
		.where(eq(topics.id, topicId));
	const version = await snapshotTopic(topicId, {
		changelog: [{ type: 'expand', text: `Regenerated topic page (${sectionsOut.length} sections, ${claimCount} claims)`, details: '' }],
		faithfulness
	}).catch(() => null);

	return { ok: true, faithfulness, sections: sectionsOut.length, claims: claimCount, version };
}
