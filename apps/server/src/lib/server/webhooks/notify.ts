/**
 * Notification producer (gap B20) — inserts real rows into the org-scoped
 * `notifications` table (the same shape GET /api/notifications serves) at key
 * pipeline events: ingestion completed/failed, conflict detected / review item
 * queued, review resolved.
 *
 * Lives beside the webhook dispatcher because both are the outbound halves of
 * the same events (webhooks for machines, notifications for humans) and this
 * directory is the wave's designated new-module home.
 *
 * Fire-and-forget: notify() never throws and never blocks the pipeline.
 * Worker-safe (getDb()/process.env only).
 */
import { getDb } from '../db/client';
import { notifications } from '../db/schema';

/** Matches packages/schemas notificationSchema.type. */
export type NotificationType = 'ssot_merge' | 'conflict' | 'novelty' | 'alert';

export interface NotifyInput {
	type: NotificationType;
	title: string;
	description: string;
	/**
	 * Action label/route. The notifications UI navigates when it starts with '/'
	 * (e.g. '/review', '/folders/f_1/doc_2') and renders it as a label otherwise.
	 */
	action?: string | null;
	/**
	 * When set, the row id is derived from it and re-emissions are dropped via
	 * ON CONFLICT DO NOTHING — e.g. one notification per review item no matter
	 * how many correlation passes re-detect the same conflict.
	 */
	dedupeKey?: string;
}

let seq = 0;

/** Persist one notification asynchronously. Never throws, never blocks. */
export function notify(orgId: string, input: NotifyInput): void {
	const db = getDb();
	if (!db) return;
	seq = (seq + 1) % 1_000_000;
	const id = input.dedupeKey
		? `nt_${input.dedupeKey.slice(0, 200)}`
		: `nt_${Date.now().toString(36)}_${seq.toString(36)}`;
	void db
		.insert(notifications)
		.values({
			id,
			orgId: orgId || 'org_1',
			type: input.type,
			title: input.title.slice(0, 200),
			description: input.description.slice(0, 500),
			action: input.action ?? null,
			read: false
		})
		.onConflictDoNothing()
		.catch((e) => {
			console.error('[notify] failed to persist notification:', e instanceof Error ? e.message : e);
		});
}
