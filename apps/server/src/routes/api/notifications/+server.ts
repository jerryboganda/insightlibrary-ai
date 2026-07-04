import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getRepository } from '$lib/server/data';

export const GET: RequestHandler = async () => {
	const items = await getRepository().listNotifications();
	return json({ items, total: items.length });
};

/** Mark all notifications read. */
export const POST: RequestHandler = async () => {
	await getRepository().markAllNotificationsRead();
	return json({ ok: true });
};
