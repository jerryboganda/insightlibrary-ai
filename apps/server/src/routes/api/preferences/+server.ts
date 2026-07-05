import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { userPreferences } from '$lib/server/db/schema';

/** GET /api/preferences — the signed-in user's saved preferences. */
export const GET: RequestHandler = async ({ locals }) => {
	const db = getDb();
	const userId = locals.user?.id;
	if (!db || !userId) return json({ prefs: {} });
	const [row] = await db.select().from(userPreferences).where(eq(userPreferences.userId, userId));
	return json({ prefs: row?.prefs ?? {} });
};

/** PATCH /api/preferences — save preferences (whole object). */
export const PATCH: RequestHandler = async ({ request, locals }) => {
	const db = getDb();
	if (!db) throw error(503, 'A database is required');
	const userId = locals.user?.id;
	if (!userId) throw error(401, 'Sign in required');
	const prefs = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	await db
		.insert(userPreferences)
		.values({ userId, prefs })
		.onConflictDoUpdate({ target: userPreferences.userId, set: { prefs, updatedAt: new Date() } });
	return json({ ok: true });
};
