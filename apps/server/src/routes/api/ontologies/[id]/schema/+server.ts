import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { requireRole } from '$lib/server/auth-guard';
import { getOntologySchema, saveOntologySchema } from '$lib/server/ontology/schema-store';

/**
 * GET /api/ontologies/[id]/schema (B23) — the real ontology schema for the
 * editor: live per-kind concept counts + sample concepts/synonyms from the
 * dictionary, overlaid with any saved editable entity/property/merge layer.
 * Read is open (any signed-in user) like the other ontology reads.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	const orgId = locals.user?.orgId || 'org_1';
	const view = await getOntologySchema(params.id, orgId);
	return json(view);
};

const propertySchema = z.object({
	id: z.string().max(80).optional(),
	name: z.string().trim().min(1).max(120),
	type: z.string().max(60).default('String'),
	required: z.boolean().default(false),
	desc: z.string().max(500).default('')
});

const entitySchema = z.object({
	id: z.string().max(80).optional(),
	name: z.string().trim().min(1).max(120),
	mergeStrategy: z.enum(['append', 'review']).default('append'),
	properties: z.array(propertySchema).max(100).default([])
});

const putSchema = z.strictObject({
	name: z.string().trim().min(1).max(120).optional(),
	status: z.enum(['active', 'draft']).optional(),
	schema: z.object({ entities: z.array(entitySchema).max(200) }).optional()
});

/**
 * PUT /api/ontologies/[id]/schema (admin) — persist editor changes (entities,
 * properties, per-entity merge strategy, name, publish status). Returns the
 * refreshed real view so the editor rehydrates from the source of truth.
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const user = requireRole(locals.user, 'admin');
	const orgId = user.orgId || 'org_1';

	const parsed = putSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		throw error(400, `Invalid schema body${first ? `: ${first.path.join('.')} ${first.message}` : ''}`);
	}

	const view = await saveOntologySchema(params.id, orgId, parsed.data);
	return json(view);
};
