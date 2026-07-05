import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { requireRole } from '$lib/server/auth-guard';
import { getDb } from '$lib/server/db/client';
import {
	deleteProject,
	getProject,
	updateProject,
	type ResearchData,
	type ResearchType
} from '$lib/server/research/store';

/**
 * Per-type `data` validators — the write boundary for a project's document, so a
 * saved project can never hold a payload the tool page can't render. Each mirrors
 * the typed shape in lib/server/research/store.ts.
 */
const argumentMapSchema = z.strictObject({
	nodes: z
		.array(
			z.strictObject({
				id: z.string().min(1).max(64),
				kind: z.enum(['premise', 'evidence', 'conclusion']),
				label: z.string().max(120),
				text: z.string().max(2000),
				source: z.string().max(200).optional()
			})
		)
		.max(200)
});

const compareMatrixSchema = z.strictObject({
	columns: z.array(z.string().max(200)).max(12),
	rows: z
		.array(
			z.strictObject({
				id: z.string().min(1).max(64),
				concept: z.string().max(300),
				cells: z
					.array(
						z.strictObject({
							text: z.string().max(2000),
							tone: z.enum(['default', 'agree', 'conflict', 'missing']).optional()
						})
					)
					.max(12)
			})
		)
		.max(200)
});

const reportSchema = z.strictObject({
	prompt: z.string().max(4000),
	strictCitation: z.boolean(),
	sources: z
		.array(
			z.strictObject({
				id: z.string().min(1).max(64),
				label: z.string().max(300),
				topicId: z.string().max(120).optional()
			})
		)
		.max(50),
	body: z.string().max(200_000),
	generatedBy: z.enum(['ai', 'manual', 'fallback']).optional(),
	generatedAt: z.string().max(40).optional(),
	wordCount: z.number().int().min(0).optional(),
	citationCount: z.number().int().min(0).optional()
});

const timelineSchema = z.strictObject({
	events: z
		.array(
			z.strictObject({
				id: z.string().min(1).max(64),
				phase: z.string().max(120),
				stage: z.string().max(120),
				description: z.string().max(2000),
				tone: z.enum(['default', 'critical'])
			})
		)
		.max(200)
});

const DATA_SCHEMAS: Record<ResearchType, z.ZodTypeAny> = {
	argument_map: argumentMapSchema,
	compare_matrix: compareMatrixSchema,
	report: reportSchema,
	timeline: timelineSchema
};

/** GET /api/research/[id] — load one project (org-scoped). */
export const GET: RequestHandler = async ({ params, locals }) => {
	const orgId = locals.user?.orgId || 'org_1';
	const project = await getProject(orgId, params.id);
	if (!project) throw error(404, 'Research project not found');
	return json(project);
};

const patchSchema = z
	.object({
		title: z.string().trim().min(1).max(200).optional(),
		/** Validated against the project's own type below. */
		data: z.unknown().optional()
	})
	.refine((p) => p.title !== undefined || p.data !== undefined, {
		message: 'At least one of title or data is required'
	});

/**
 * PATCH /api/research/[id] (editor+) — rename and/or replace the document. The
 * `data` blob is validated against the project's stored type.
 */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	const user = requireRole(locals.user, 'editor');
	const orgId = user.orgId || 'org_1';

	const db = getDb();
	if (!db) throw error(503, 'Research projects require the database');

	const existing = await getProject(orgId, params.id);
	if (!existing) throw error(404, 'Research project not found');

	const parsed = patchSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		throw error(400, `Invalid research patch${first ? `: ${first.path.join('.')} ${first.message}` : ''}`);
	}

	let data: ResearchData | undefined;
	if (parsed.data.data !== undefined) {
		const dataParsed = DATA_SCHEMAS[existing.type].safeParse(parsed.data.data);
		if (!dataParsed.success) {
			const first = dataParsed.error.issues[0];
			throw error(400, `Invalid ${existing.type} data${first ? `: ${first.path.join('.')} ${first.message}` : ''}`);
		}
		data = dataParsed.data as ResearchData;
	}

	const updated = await updateProject(orgId, params.id, { title: parsed.data.title, data });
	if (!updated) throw error(404, 'Research project not found');
	return json(updated);
};

/** DELETE /api/research/[id] (editor+). */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	const user = requireRole(locals.user, 'editor');
	const orgId = user.orgId || 'org_1';

	const db = getDb();
	if (!db) throw error(503, 'Research projects require the database');

	const ok = await deleteProject(orgId, params.id);
	if (!ok) throw error(404, 'Research project not found');
	return json({ ok: true });
};
