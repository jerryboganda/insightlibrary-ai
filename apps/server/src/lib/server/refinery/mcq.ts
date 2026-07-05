/**
 * MCQ / vignette generation from a topic's evidence claims (provider structured
 * output). Each MCQ links to the claim it tests, inheriting its citations.
 */
import { getDb } from '../db/client';
import { mcqs } from '../db/schema';
import { getRouter } from '../ai/providers';
import { getOrgSettings } from '../org-settings';
import { retrieveTopicEvidence } from './retrieve';

const MCQ_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		mcqs: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					stem: { type: 'string' },
					options: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] } },
					correctOptionId: { type: 'string' },
					explanation: { type: 'string' },
					difficulty: { type: 'string' },
					claimId: { type: 'string' }
				},
				required: ['stem', 'options', 'correctOptionId']
			}
		}
	},
	required: ['mcqs']
};

export async function generateMcqsForTopic(
	topicId: string,
	orgId = 'org_1',
	count = 5
): Promise<{ generated: number; status: 'draft' | 'published' }> {
	// C9 governance gate: when the org requires human review, AI-generated
	// questions land as drafts (invisible to learners until an editor publishes
	// them via PATCH /api/mcqs/[id]). Live org_settings read — no restart needed.
	const status: 'draft' | 'published' = (await getOrgSettings(orgId)).requireReview
		? 'draft'
		: 'published';
	const db = getDb();
	if (!db) return { generated: 0, status };
	const router = getRouter();
	if (!router.available('synthesis')) return { generated: 0, status };
	const { topicName, evidence } = await retrieveTopicEvidence(topicId);
	if (!evidence.length) return { generated: 0, status };

	const validClaimIds = new Set(evidence.map((e) => e.id));
	const claimList = evidence.slice(0, 60).map((e) => `[${e.id}] ${e.text}`).join('\n');
	const res = await router
		.json<{ mcqs: { stem: string; options: { id: string; text: string }[]; correctOptionId: string; explanation?: string; difficulty?: string; claimId?: string }[] }>(
			[
				{
					role: 'user',
					content:
						`Write ${count} board-style single-best-answer MCQs for "${topicName}" using ONLY these claims. ` +
						'Each: a clinical stem, 4-5 options with ids A-E, correctOptionId, a one-line explanation, difficulty ' +
						'(easy|medium|hard), and claimId (the claim it tests). Return JSON {"mcqs":[...]}.\n\n' +
						claimList
				}
			],
			{ task: 'synthesis', schema: MCQ_SCHEMA, temperature: 0.3 }
		)
		.catch(() => null);
	if (!res?.mcqs?.length) return { generated: 0, status };

	let n = 0;
	const stamp = Date.now();
	for (let i = 0; i < res.mcqs.length; i++) {
		const m = res.mcqs[i];
		if (!m.stem?.trim() || !m.options?.length || !m.correctOptionId) continue;
		await db
			.insert(mcqs)
			.values({
				id: `mcq_${topicId}_${stamp}_${i}`,
				orgId,
				topicId,
				claimId: m.claimId && validClaimIds.has(m.claimId) ? m.claimId : null,
				stem: m.stem,
				options: m.options,
				correctOptionId: m.correctOptionId,
				explanation: m.explanation ?? '',
				difficulty: ['easy', 'medium', 'hard'].includes(m.difficulty ?? '') ? (m.difficulty as string) : 'medium',
				status
			})
			.onConflictDoNothing();
		n++;
	}
	return { generated: n, status };
}
