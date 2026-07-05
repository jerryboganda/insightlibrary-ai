import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireRole } from '$lib/server/auth-guard';
import { getDb } from '$lib/server/db/client';
import { getProject, updateProject, type ReportData } from '$lib/server/research/store';
import { generateReport } from '$lib/server/research/generate';

/**
 * POST /api/research/[id]/generate (editor+) — generate the report body for a
 * `report` project through the per-org provider router ('synthesis'), grounded
 * strictly in the selected SSOT sources' claims, and persist it. Honest failure
 * (ok:false + reason) when no evidence is linked; deterministic digest when no
 * AI provider is configured. Only valid for report projects. (B10)
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	const user = requireRole(locals.user, 'editor');
	const orgId = user.orgId || 'org_1';

	const db = getDb();
	if (!db) throw error(503, 'Report generation requires the database');

	const project = await getProject(orgId, params.id);
	if (!project) throw error(404, 'Research project not found');
	if (project.type !== 'report') throw error(400, 'Only report projects can be generated');

	const data = project.data as ReportData;
	const result = await generateReport(orgId, data, user.id ?? null);

	if (!result.ok) {
		return json({ ok: false, reason: result.reason ?? 'Nothing to generate' }, { status: 200 });
	}

	// Persist the generated body onto the project so a reload shows it.
	const nextData: ReportData = {
		...data,
		body: result.body,
		generatedBy: result.generatedBy,
		generatedAt: new Date().toISOString(),
		wordCount: result.wordCount,
		citationCount: result.citationCount
	};
	const updated = await updateProject(orgId, params.id, { data: nextData });

	return json({
		ok: true,
		generatedBy: result.generatedBy,
		body: result.body,
		wordCount: result.wordCount,
		citationCount: result.citationCount,
		project: updated
	});
};
