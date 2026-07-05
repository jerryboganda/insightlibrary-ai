import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { getRepository } from '$lib/server/data';
import { requireRole } from '$lib/server/auth-guard';
import { getDb } from '$lib/server/db/client';
import { organizations, sources } from '$lib/server/db/schema';

export const GET: RequestHandler = async () => {
	const items = await getRepository().listSources();
	return json({ items, total: items.length });
};

const createSchema = z.strictObject({
	name: z.string().trim().min(1).max(200),
	author: z.string().trim().max(200).default(''),
	type: z.string().trim().min(1).max(80).default('Textbook'),
	/** 1 = highest priority for conflict resolution. */
	priority: z.number().int().min(1).max(10).default(3),
	date: z.string().trim().min(1).max(40).optional()
});

function slug(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
}

/**
 * POST /api/sources (editor+) — register a source in the org registry (A5).
 * Registered ids become citation tokens: claim provenance (claim_sources
 * .source_id) and the topic coverage matrix columns resolve against them.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const user = requireRole(locals.user, 'editor');
	const orgId = user.orgId || 'org_1';

	const db = getDb();
	if (!db) throw error(503, 'Source registry writes require the database');

	const parsed = createSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		throw error(400, `Invalid source body${first ? `: ${first.path.join('.')} ${first.message}` : ''}`);
	}

	// FK guard (same convention as org-settings): better-auth orgs are not yet
	// mirrored into the app organizations table — ensure a minimal row exists.
	await db
		.insert(organizations)
		.values({ id: orgId, name: orgId, slug: orgId, tenantId: orgId })
		.onConflictDoNothing();

	const id = `src_${slug(parsed.data.name) || 'source'}_${Date.now().toString(36)}`;
	const [row] = await db
		.insert(sources)
		.values({
			id,
			orgId,
			name: parsed.data.name,
			author: parsed.data.author,
			type: parsed.data.type,
			priority: parsed.data.priority,
			date: parsed.data.date ?? String(new Date().getFullYear())
		})
		.returning();

	return json(
		{ id: row.id, name: row.name, author: row.author, type: row.type, priority: row.priority, date: row.date },
		{ status: 201 }
	);
};

