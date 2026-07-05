import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { requireRole } from '$lib/server/auth-guard';
import { updateGoldenItem, deleteGoldenItem } from '$lib/server/eval/golden-store';

/**
 * Edit / remove a single golden evaluation item (gap C8, admin+). Both seed and
 * custom items are editable/removable — the set is fully admin-owned once seeded.
 */
const patchSchema = z
	.object({
		query: z.string().trim().min(1).max(500).optional(),
		expect: z.string().trim().min(1).max(500).optional()
	})
	.refine((p) => p.query !== undefined || p.expect !== undefined, 'Nothing to update');

export const PATCH: RequestHandler = async ({ request, params, locals }) => {
	const user = requireRole(locals.user, 'admin');
	const orgId = user.orgId || 'org_1';

	const parsed = patchSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		throw error(400, `Invalid update${first ? `: ${first.message}` : ''}`);
	}

	try {
		const item = await updateGoldenItem(orgId, params.id, parsed.data);
		if (!item) throw error(404, 'Golden item not found');
		return json(item);
	} catch (e) {
		if (e instanceof Error && 'status' in e) throw e;
		throw error(503, e instanceof Error ? e.message : 'Failed to update golden item');
	}
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	const user = requireRole(locals.user, 'admin');
	const orgId = user.orgId || 'org_1';

	try {
		const ok = await deleteGoldenItem(orgId, params.id);
		if (!ok) throw error(404, 'Golden item not found');
		return json({ ok: true });
	} catch (e) {
		if (e instanceof Error && 'status' in e) throw e;
		throw error(503, e instanceof Error ? e.message : 'Failed to remove golden item');
	}
};
