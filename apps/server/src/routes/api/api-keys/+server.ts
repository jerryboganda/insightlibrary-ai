import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { desc, eq } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { getDb } from '$lib/server/db/client';
import { apiKeys } from '$lib/server/db/schema';
import { requireRole } from '$lib/server/auth-guard';

/** GET /api/api-keys — list org API keys (never returns the secret). */
export const GET: RequestHandler = async ({ locals }) => {
	const db = getDb();
	if (!db) return json({ items: [], total: 0 });
	const rows = await db
		.select()
		.from(apiKeys)
		.where(eq(apiKeys.orgId, locals.user?.orgId || 'org_1'))
		.orderBy(desc(apiKeys.createdAt));
	const items = rows.map((r) => ({
		id: r.id,
		name: r.name,
		tokenHint: r.tokenHint,
		createdAt: r.createdAt.toISOString(),
		lastUsedAt: r.lastUsedAt?.toISOString() ?? null
	}));
	return json({ items, total: items.length });
};

/** POST /api/api-keys { name } — mint a key; returns the secret ONCE. */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireRole(locals.user, 'admin');
	const db = getDb();
	if (!db) throw error(503, 'A database is required');
	const body = (await request.json().catch(() => ({}))) as { name?: string };
	const name = (body.name ?? 'API Key').slice(0, 60);
	const token = 'sk_live_' + randomBytes(24).toString('hex');
	const tokenHash = createHash('sha256').update(token).digest('hex');
	const id = `ak_${Date.now()}`;
	await db.insert(apiKeys).values({
		id,
		orgId: locals.user?.orgId || 'org_1',
		name,
		tokenHash,
		tokenHint: `…${token.slice(-4)}`,
		createdBy: locals.user?.id ?? null
	});
	return json({ id, name, token, tokenHint: `…${token.slice(-4)}` });
};
