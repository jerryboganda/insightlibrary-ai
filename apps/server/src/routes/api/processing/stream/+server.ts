import type { RequestHandler } from './$types';
import { onIngestionProgress } from '$lib/server/jobs/ingestion';
import { listProgressRows, type ProgressEvent } from '$lib/server/jobs/processing-store';

/**
 * Live ingestion progress as SSE. Two sources so progress is visible regardless
 * of where runIngestion executes:
 *  - in-process events (dev inline path, no worker), and
 *  - polling the processing_jobs table (production worker writes there → this
 *    fixes the "worker progress invisible to the API SSE" bug).
 */
export const GET: RequestHandler = async () => {
	const encoder = new TextEncoder();
	let unsub = () => {};
	let timer: ReturnType<typeof setInterval> | null = null;
	const last = new Map<string, string>();

	const stream = new ReadableStream({
		async start(controller) {
			const push = (e: ProgressEvent) =>
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));

			unsub = onIngestionProgress(push);
			controller.enqueue(encoder.encode(': connected\n\n'));

			const poll = async () => {
				try {
					for (const r of await listProgressRows()) {
						const key = `${r.stage}:${r.progress}:${r.message}`;
						if (last.get(r.documentId) !== key) {
							last.set(r.documentId, key);
							push(r);
						}
					}
				} catch {
					/* transient DB error — keep the stream open */
				}
			};
			await poll();
			timer = setInterval(poll, 1200);
		},
		cancel() {
			unsub();
			if (timer) clearInterval(timer);
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
