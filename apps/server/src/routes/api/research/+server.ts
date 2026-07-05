import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { requireRole } from '$lib/server/auth-guard';
import { getDb } from '$lib/server/db/client';
import { organizations } from '$lib/server/db/schema';
import {
	createProject,
	emptyData,
	isResearchType,
	listProjects,
	RESEARCH_TYPES,
	type ResearchType
} from '$lib/server/research/store';
import { seedCompareMatrix } from '$lib/server/research/generate';

/**
 * GET /api/research[?type=…] — list the org's research projects (hub + tool
 * "recent" pickers). Empty list when no database is configured. (B10)
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	const orgId = locals.user?.orgId || 'org_1';
	const typeParam = url.searchParams.get('type');
	if (typeParam && !isResearchType(typeParam)) {
		throw error(400, `Unknown research type "${typeParam}"`);
	}
	const items = await listProjects(orgId, typeParam ? (typeParam as ResearchType) : undefined);
	return json({ items, total: items.length });
};

const createSchema = z.strictObject({
	type: z.enum(RESEARCH_TYPES),
	title: z.string().trim().min(1).max(200)
});

/**
 * POST /api/research (editor+) — create a project. Compare-matrix projects are
 * seeded with real source-registry columns; others start from an empty document.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const user = requireRole(locals.user, 'editor');
	const orgId = user.orgId || 'org_1';

	const db = getDb();
	if (!db) throw error(503, 'Research projects require the database');

	const parsed = createSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		throw error(400, `Invalid research body${first ? `: ${first.path.join('.')} ${first.message}` : ''}`);
	}

	// FK guard (sources-registry convention): ensure a minimal org row exists —
	// better-auth orgs are not yet mirrored into the app organizations table (C10).
	await db
		.insert(organizations)
		.values({ id: orgId, name: orgId, slug: orgId, tenantId: orgId })
		.onConflictDoNothing();

	const data =
		parsed.data.type === 'compare_matrix'
			? await seedCompareMatrix(orgId)
			: emptyData(parsed.data.type);

	const project = await createProject({
		orgId,
		type: parsed.data.type,
		title: parsed.data.title,
		data,
		createdBy: user.id ?? null
	});
	if (!project) throw error(500, 'Failed to create research project');
	return json(project, { status: 201 });
};
