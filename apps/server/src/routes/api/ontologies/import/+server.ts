import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { requireRole } from '$lib/server/auth-guard';
import { getDb } from '$lib/server/db/client';
import {
	IMPORT_FORMATS,
	OntologyParseError,
	detectImportFormat,
	importOntology,
	parseOntologyInput
} from '$lib/server/ontology/load';

function slug(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 40);
}

const RESERVED_SLUGS = new Set(['mesh', 'mondo', 'hpo', 'rxnorm', 'umls', 'snomed']);

// Synchronous cap: embedding one row per label/synonym is the slow part. This
// keeps a single HTTP request bounded; larger sets are rejected with guidance to
// use the CLI loader (scripts/ontology + load-runner.ts) rather than silently
// truncating. Honest hard limit, not fake progress.
const MAX_SYNC_CONCEPTS = 2000;

const importSchema = z.strictObject({
	/** Raw payload text (loader JSON, a term list, or OBO). */
	content: z.string().min(1),
	/** Target concept slug (concepts.ontology). Defaults from name or 'custom'. */
	ontology: z.string().trim().min(1).max(40).optional(),
	/** Display name for the ontology metadata row. */
	name: z.string().trim().min(1).max(120).optional(),
	/** Force a parser; auto-detected when omitted. */
	format: z.enum(IMPORT_FORMATS).optional()
});

/**
 * POST /api/ontologies/import (admin) — parse an uploaded ontology and persist
 * it through the real load path (A11), then refresh its metadata row. Supports
 * the loader JSON shape, a simple term list, and minimal OBO. Runs synchronously
 * (bounded by MAX_SYNC_CONCEPTS); the response carries real load counts so the
 * modal can show an honest result.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const user = requireRole(locals.user, 'admin');
	const orgId = user.orgId || 'org_1';

	const db = getDb();
	if (!db) throw error(503, 'Ontology import requires the database');

	const parsed = importSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		throw error(400, `Invalid import body${first ? `: ${first.path.join('.')} ${first.message}` : ''}`);
	}

	const desired = slug(parsed.data.ontology ?? parsed.data.name ?? 'custom') || 'custom';
	if (RESERVED_SLUGS.has(desired)) {
		throw error(409, `"${desired}" is a reserved standard ontology slug — choose another target slug/name`);
	}
	const format = parsed.data.format ?? detectImportFormat(parsed.data.content);

	// Parse first so validation errors return 400 before any embedding cost, and
	// so oversized loads are rejected up front.
	let conceptCount: number;
	try {
		const data = parseOntologyInput(parsed.data.content, { ontology: desired, format });
		conceptCount = data.concepts.length;
	} catch (e) {
		if (e instanceof OntologyParseError) throw error(400, e.message);
		throw e;
	}

	if (conceptCount > MAX_SYNC_CONCEPTS) {
		throw error(
			413,
			`Payload has ${conceptCount} concepts (limit ${MAX_SYNC_CONCEPTS} for interactive import). ` +
				`Load large ontologies with the CLI runner: tsx src/lib/server/ontology/load-runner.ts <file>.`
		);
	}

	try {
		const result = await importOntology(orgId, parsed.data.content, {
			ontology: desired,
			name: parsed.data.name,
			format
		});
		return json({ ok: true, format, ...result }, { status: 201 });
	} catch (e) {
		if (e instanceof OntologyParseError) throw error(400, e.message);
		console.error('[ontology-import] load failed:', e instanceof Error ? e.message : e);
		throw error(500, 'Ontology import failed while persisting concepts');
	}
};
