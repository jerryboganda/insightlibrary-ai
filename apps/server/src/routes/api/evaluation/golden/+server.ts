import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { requireRole } from '$lib/server/auth-guard';
import { listGoldenItems, createGoldenItem } from '$lib/server/eval/golden-store';

/**
 * Admin-manageable golden evaluation set (gap C8).
 *  - GET  → list the org's golden items (seeded from the bundled set on first
 *           read so existing behavior is preserved).
 *  - POST → add a custom golden item (admin+).
 * Editing/removing individual items lives under [id].
 */
export const GET: RequestHandler = async ({ locals }) => {
	requireRole(locals.user, 'admin');
	const orgId = locals.user?.orgId || 'org_1';
	const items = await listGoldenItems(orgId);
	return json({ items, total: items.length });
};

const createSchema = z.object({
	query: z.string().trim().min(1).max(500),
	expect: z.string().trim().min(1).max(500)
});

export const POST: RequestHandler = async ({ request, locals }) => {
	const user = requireRole(locals.user, 'admin');
	const orgId = user.orgId || 'org_1';

	const parsed = createSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		throw error(400, `Invalid golden item${first ? `: ${first.path.join('.')} ${first.message}` : ''}`);
	}

	try {
		const item = await createGoldenItem(orgId, parsed.data);
		return json(item, { status: 201 });
	} catch (e) {
		throw error(503, e instanceof Error ? e.message : 'Failed to add golden item');
	}
};
