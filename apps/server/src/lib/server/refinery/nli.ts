/**
 * Natural-language-inference pair classifier via the provider layer. Used by
 * dedup (equivalent) and conflict detection (contradiction). Returns null when
 * no provider is configured so callers can fall back to cosine-only behavior.
 */
import { getRouter } from '../ai/providers';

export type Relation = 'equivalent' | 'entailment' | 'contradiction' | 'neutral';

const SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		relation: { type: 'string', enum: ['equivalent', 'entailment', 'contradiction', 'neutral'] },
		confidence: { type: 'number' }
	},
	required: ['relation']
};

export async function classifyPair(a: string, b: string): Promise<{ relation: Relation; confidence: number } | null> {
	const router = getRouter();
	if (!router.available('nli')) return null;
	const res = await router
		.json<{ relation: Relation; confidence?: number }>(
			[
				{
					role: 'user',
					content:
						'Two medical statements.\n' +
						`A: "${a}"\nB: "${b}"\n\n` +
						'Classify their logical relation: "equivalent" (assert the same fact), "entailment" (one implies the ' +
						'other), "contradiction" (cannot both be true), or "neutral". Return JSON {relation, confidence 0..1}.'
				}
			],
			{ task: 'nli', schema: SCHEMA, temperature: 0 }
		)
		.catch(() => null);
	if (!res?.relation) return null;
	return { relation: res.relation, confidence: res.confidence ?? 0.5 };
}
