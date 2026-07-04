import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { copilotRequestSchema } from '@insightlibrary/schemas';
import { getRepository } from '$lib/server/data';
import { streamCopilot } from '$lib/server/ai/gemini';

/**
 * Copilot endpoint — Server-Sent Events. Each frame is a JSON CopilotChunk.
 * SSE (not WebSockets) is SvelteKit's blessed realtime transport and works with
 * the Tauri webview's EventSource/fetch. The Gemini key stays server-side.
 */
export const POST: RequestHandler = async ({ request }) => {
	const parsed = copilotRequestSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) throw error(400, 'Invalid copilot request');
	const { mode, message, topicId } = parsed.data;

	// Ground strict-citation / SSOT modes in the topic's claims.
	let context: string | undefined;
	if (topicId && (mode === 'strict_citation' || mode === 'ssot')) {
		const topic = await getRepository().getTopic(topicId);
		if (topic?.sections) {
			context = topic.sections
				.flatMap((s) => s.claims.map((c) => `- ${c.content} [${c.citations.join(' ')}]`))
				.join('\n');
		}
	}

	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			const send = (type: string, value: string) =>
				controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type, value })}\n\n`));
			try {
				for await (const token of streamCopilot({ mode, message, context })) {
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
