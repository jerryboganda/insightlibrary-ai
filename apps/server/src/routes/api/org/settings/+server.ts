import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { requireRole } from '$lib/server/auth-guard';
import {
	getOrgSettings,
	updateOrgSettings,
	orgSettingsDefaults,
	PARSE_MODES,
	RERANK_MODES,
	type ResolvedOrgSettings
} from '$lib/server/org-settings';
import { MODE_SYSTEM_PROMPTS } from '$lib/server/ai/gemini';

/**
 * Org settings — the admin-manageable configuration store backing the General
 * and Governance settings pages (C1/C2/C3/C11). GET returns effective values
 * (env defaults overlaid with stored overrides); PUT (admin+) persists a merge
 * patch. Refinery/search/pipeline code reads the same store at runtime via
 * lib/server/org-settings.ts, so saves apply within seconds — no restart.
 */

function toResponse(resolved: ResolvedOrgSettings) {
	const { orgId: _orgId, name, logo, overridden, updatedAt, ...settings } = resolved;
	return {
		name,
		logo,
		settings,
		defaults: orgSettingsDefaults(),
		overridden,
		copilotPromptDefaults: MODE_SYSTEM_PROMPTS,
		updatedAt
	};
}

export const GET: RequestHandler = async ({ locals }) => {
	const orgId = locals.user?.orgId || 'org_1';
	return json(toResponse(await getOrgSettings(orgId)));
};

const nullableNum = (min: number, max: number) => z.number().min(min).max(max).nullable();
const nullableInt = (min: number, max: number) => z.number().int().min(min).max(max).nullable();

const settingsPatchSchema = z
	.strictObject({
		strictCitationDefault: z.boolean().nullable(),
		autoSsotTopics: z.boolean().nullable(),
		requireReview: z.boolean().nullable(),
		autoMergeConfidence: nullableNum(0, 100),
		dedupCosine: nullableNum(0, 1),
		dedupUseNli: z.boolean().nullable(),
		conflictSubjectCosine: nullableNum(0, 1),
		conflictEnabled: z.boolean().nullable(),
		maxCorrelateClaims: nullableInt(1, 5000),
		parseMode: z.enum(PARSE_MODES).nullable(),
		parseAiMaxPages: nullableInt(1, 500),
		claimsMaxChunks: nullableInt(1, 2000),
		contextualMaxChunks: nullableInt(0, 5000),
		ontologyLinkMaxDistance: nullableNum(0, 1),
		rerank: z.enum(RERANK_MODES).nullable(),
		searchRrfK: nullableInt(1, 500),
		searchCandidates: nullableInt(5, 200),
		searchTopK: nullableInt(1, 100),
		searchSnippetLength: nullableInt(80, 2000),
		copilotPromptOverrides: z.record(z.string(), z.string().max(4000)).nullable(),
		sourcePriorityOrder: z.array(z.string().min(1).max(200)).max(100).nullable()
	})
	.partial();

const updateSchema = z.strictObject({
	name: z.string().trim().min(1).max(120).optional(),
	logo: z
		.string()
		.regex(/^data:image\//, 'Logo must be a data:image/* URL')
		.max(600_000, 'Logo too large (max ~450 KB)')
		.nullable()
		.optional(),
	settings: settingsPatchSchema.optional()
});

export const PUT: RequestHandler = async ({ request, locals }) => {
	const user = requireRole(locals.user, 'admin');
	const orgId = user.orgId || 'org_1';

	const parsed = updateSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		throw error(400, `Invalid org settings body${first ? `: ${first.path.join('.')} ${first.message}` : ''}`);
	}

	// Copilot prompt overrides must target known modes.
	const overrides = parsed.data.settings?.copilotPromptOverrides;
	if (overrides) {
		for (const key of Object.keys(overrides)) {
			if (!(key in MODE_SYSTEM_PROMPTS)) throw error(400, `Unknown copilot mode "${key}"`);
		}
	}

	let resolved: ResolvedOrgSettings;
	try {
		resolved = await updateOrgSettings(orgId, parsed.data);
	} catch (e) {
		throw error(503, e instanceof Error ? e.message : 'Failed to persist org settings');
	}
	return json(toResponse(resolved));
};
