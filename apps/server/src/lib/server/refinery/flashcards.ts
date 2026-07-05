/**
 * Flashcard generation from a topic's evidence claims (provider structured
 * output). New cards start in state 'new' / due now; scheduled via SM-2 on review.
 */
import { getDb } from '../db/client';
import { flashcards } from '../db/schema';
import { getRouter } from '../ai/providers';
import { retrieveTopicEvidence } from './retrieve';

const CARD_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		cards: {
			type: 'array',
			items: {
				type: 'object',
				properties: { front: { type: 'string' }, back: { type: 'string' }, claimId: { type: 'string' } },
				required: ['front', 'back']
			}
		}
	},
	required: ['cards']
};

export async function generateFlashcardsForTopic(topicId: string, count = 8): Promise<{ generated: number }> {
	const db = getDb();
	if (!db) return { generated: 0 };
	const router = getRouter();
	if (!router.available('synthesis')) return { generated: 0 };
	const { topicName, evidence } = await retrieveTopicEvidence(topicId);
	if (!evidence.length) return { generated: 0 };

	const validClaimIds = new Set(evidence.map((e) => e.id));
	const claimList = evidence.slice(0, 60).map((e) => `[${e.id}] ${e.text}`).join('\n');
	const res = await router
		.json<{ cards: { front: string; back: string; claimId?: string }[] }>(
			[
				{
					role: 'user',
					content:
						`Write ${count} high-yield flashcards for "${topicName}" using ONLY these claims. Each: a concise front ` +
						'(question/cue) and back (answer), plus claimId. Return JSON {"cards":[...]}.\n\n' +
						claimList
				}
			],
			{ task: 'synthesis', schema: CARD_SCHEMA, temperature: 0.3 }
		)
		.catch(() => null);
	if (!res?.cards?.length) return { generated: 0 };

	let n = 0;
	const stamp = Date.now();
	for (let i = 0; i < res.cards.length; i++) {
		const c = res.cards[i];
		if (!c.front?.trim() || !c.back?.trim()) continue;
		await db
			.insert(flashcards)
			.values({
				id: `fc_${topicId}_${stamp}_${i}`,
				topicId,
				topic: topicName,
				front: c.front,
				back: c.back,
				sourceClaimId: c.claimId && validClaimIds.has(c.claimId) ? c.claimId : null,
				state: 'new',
				dueAt: new Date()
			})
			.onConflictDoNothing();
		n++;
	}
	return { generated: n };
}
