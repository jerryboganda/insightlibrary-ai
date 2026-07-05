import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { copilotRequestSchema } from '@insightlibrary/schemas';
import { getRepository } from '$lib/server/data';
import { streamCopilot } from '$lib/server/ai/gemini';
import { resolveChatCredential } from '$lib/server/ai/credentials';
import { retrieveGlobalContext } from '$lib/server/graph/community';

/**
 * Copilot endpoint — Server-Sent Events. Each frame is a JSON CopilotChunk.
 * SSE (not WebSockets) is SvelteKit's blessed realtime transport and works with
 * the Tauri webview's EventSource/fetch. The Gemini key stays server-side.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const parsed = copilotRequestSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) throw error(400, 'Invalid copilot request');
	const { mode, message, topicId, attachment } = parsed.data;
	const orgId = locals.user?.orgId || 'org_1';
	const repo = getRepository();

	let context: string | undefined;

	// (1) An explicit in-context attachment (topic/document chip) grounds ANY mode.
	//     Topic → its canonical claims; document → the top retrieved chunks from
	//     that document for the question (real retrieval, not the whole file).
	if (attachment) {
		if (attachment.kind === 'topic') {
			const topic = await repo.getTopic(attachment.id).catch(() => null);
			if (topic?.sections?.length) {
				context = `Attached topic "${topic.name}" — canonical claims:\n${topic.sections
					.flatMap((s) => s.claims.map((c) => `- ${c.content} [${c.citations.join(' ')}]`))
					.join('\n')}`;
			}
		} else {
			const doc = await repo.getDocument(attachment.id).catch(() => null);
			const { results } = await repo.search(message).catch(() => ({ results: [] }));
			// Search chunk hrefs are /folders/{folderId}/{documentId}; keep only this doc.
			const passages = results
				.filter((r) => r.kind === 'chunk' && r.href.endsWith(`/${attachment.id}`))
				.slice(0, 8)
				.map((r) => `- ${r.snippet}`);
			if (passages.length) {
				context = `Attached document "${doc?.title ?? attachment.label ?? attachment.id}" — relevant passages:\n${passages.join('\n')}`;
			}
		}
	}

	// (2) Otherwise ground strict-citation / SSOT modes in the current topic's claims.
	if (!context && topicId && (mode === 'strict_citation' || mode === 'ssot')) {
		const topic = await repo.getTopic(topicId).catch(() => null);
		if (topic?.sections) {
			context = topic.sections
				.flatMap((s) => s.claims.map((c) => `- ${c.content} [${c.citations.join(' ')}]`))
				.join('\n');
		}
	}
	// Dual-level GraphRAG: broad "research"/"deep_reasoning" queries get global
	// community-level themes as context.
	if (!context && (mode === 'research' || mode === 'deep_reasoning')) {
		const themes = await retrieveGlobalContext(orgId).catch(() => []);
		if (themes.length) context = `Knowledge-base themes:\n${themes.map((t) => `- ${t}`).join('\n')}`;
	}

	// Credential precedence: a per-request forwarded ChatGPT OAuth token (desktop
	// subscription) > stored per-user/per-org key > env > mock.
	const oauthToken = request.headers.get('x-ai-oauth-token');
	const credential = oauthToken
		? { provider: 'chatgpt-oauth' as const, oauthToken }
		: await resolveChatCredential({
				orgId,
				userId: locals.user?.id
			}).catch(() => null);

	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			const send = (type: string, value: string) =>
				controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type, value })}\n\n`));
			try {
				for await (const token of streamCopilot({ mode, message, context, orgId, ctx: credential ? { credential } : undefined })) {
					send('token', token);
				}
				send('done', '');
			} catch (e) {
				send('error', e instanceof Error ? e.message : 'stream failed');
			} finally {
				controller.close();
			}
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
};
