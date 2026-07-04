import type { RequestHandler } from './$types';
import { onIngestionProgress } from '$lib/server/jobs/ingestion';

/**
 * Live ingestion progress as SSE. The processing screen subscribes here and
 * updates job rows as each stage advances.
 */
export const GET: RequestHandler = async () => {
	const encoder = new TextEncoder();
	let unsub = () => {};
	const stream = new ReadableStream({
		start(controller) {
			unsub = onIngestionProgress((e) => {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
			});
			// Comment ping to open the stream immediately.
			controller.enqueue(encoder.encode(': connected\n\n'));
		},
		cancel() {
			unsub();
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
