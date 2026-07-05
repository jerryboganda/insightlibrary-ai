import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { requireRole } from '$lib/server/auth-guard';
import { getDb } from '$lib/server/db/client';
import { sources } from '$lib/server/db/schema';

const patchSchema = z
	.strictObject({
		name: z.string().trim().min(1).max(200),
		author: z.string().trim().max(200),
		type: z.string().trim().min(1).max(80),
		/** 1 = highest priority for conflict resolution. */
		priority: z.number().int().min(1).max(10),
		date: z.string().trim().min(1).max(40)
	})
	.partial()
	.refine((p) => Object.keys(p).length > 0, { message: 'At least one field required' });

/**
 * PATCH /api/sources/[id] (editor+) — edit a registered source (A5). The id is
 * immutable because claim_sources.source_id and citation tokens reference it.
 */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	const user = requireRole(locals.user, 'editor');
	const orgId = user.orgId || 'org_1';

	const db = getDb();
	if (!db) throw error(503, 'Source registry writes require the database');

	const parsed = patchSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		throw error(400, `Invalid source patch${first ? `: ${first.path.join('.')} ${first.message}` : ''}`);
	}

	const [existing] = await db.select().from(sources).where(eq(sources.id, params.id));
	if (!existing || existing.orgId !== orgId) throw error(404, 'Source not found');

	const [row] = await db.update(sources).set(parsed.data).where(eq(sources.id, params.id)).returning();
	return json({ id: row.id, name: row.name, author: row.author, type: row.type, priority: row.priority, date: row.date });
};
