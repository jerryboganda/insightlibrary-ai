import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRouter } from '$lib/server/ai/providers';
import { retrieveTopicEvidence } from '$lib/server/refinery/retrieve';

/** POST /api/topics/[id]/case — generate a clinical vignette grounded in claims. */
export const POST: RequestHandler = async ({ params }) => {
	const { topicName, evidence } = await retrieveTopicEvidence(params.id);
	if (!evidence.length) throw error(422, 'No evidence claims for this topic yet');
	const router = getRouter();
	if (!router.available('synthesis')) throw error(503, 'Configure an AI provider to generate cases');

	const claimList = evidence.slice(0, 40).map((e) => `- ${e.text}`).join('\n');
	const text = await router.complete(
		[
			{
				role: 'user',
				content:
					`Write a realistic clinical vignette (case scenario) about "${topicName}" grounded ONLY in the facts ` +
					'below, then pose 2-3 teaching questions each with a brief model answer. Keep it concise.\n\nFacts:\n' +
					claimList
			}
		],
		{ task: 'synthesis', temperature: 0.4, maxTokens: 900 }
	);
	return json({ case: text });
};
