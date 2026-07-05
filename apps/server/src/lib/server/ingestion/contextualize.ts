/**
 * Contextual Retrieval (Anthropic method): before embedding/indexing each chunk,
 * generate a short line situating it within its document. Cuts retrieval failures
 * substantially. One cheap provider call per chunk (capped + skipped when no
 * provider is configured). Worker-safe (process.env via the provider layer).
 */
import { getRouter } from '../ai/providers';
import { getOrgSettings } from '../org-settings';

export async function contextualizeChunks(
	docTitle: string,
	chunks: string[],
	orgId = 'org_1'
): Promise<(string | null)[]> {
	const router = getRouter(orgId);
	if (!router.available('extraction')) return chunks.map(() => null);

	// Admin-tunable per-document chunk cap (org settings; falls back to
	// CONTEXTUAL_MAX_CHUNKS env, then the built-in default) instead of env-only.
	const cap = (await getOrgSettings(orgId).catch(() => null))?.contextualMaxChunks ?? Number(process.env.CONTEXTUAL_MAX_CHUNKS ?? '150');
	const out: (string | null)[] = [];
	for (let i = 0; i < chunks.length; i++) {
		if (i >= cap) {
			out.push(null);
			continue;
		}
		try {
			const text = await router.complete(
				[
					{
						role: 'user',
						content:
							`Document: "${docTitle}".\nChunk:\n"""${chunks[i].slice(0, 1200)}"""\n\n` +
							'Write ONE short sentence (max 25 words) situating this chunk within the ' +
							'document/topic to improve search retrieval. Output only the sentence.'
					}
				],
				{ task: 'extraction', temperature: 0, maxTokens: 80 }
			);
			const prefix = text.trim().replace(/\s+/g, ' ').slice(0, 300);
			out.push(prefix || null);
		} catch {
			out.push(null);
		}
	}
	return out;
}
