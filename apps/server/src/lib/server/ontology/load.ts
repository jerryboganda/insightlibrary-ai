/**
 * Ontology loader. Inserts concepts + synonyms + edges and precomputes one
 * embedding per label/synonym (concept_embeddings) for entity linking.
 *
 * The bundled seed (resources/ontologies/seed.json) covers the vertical slice.
 * Full MeSH/Mondo/HPO/RxNorm are produced by scripts/ontology/build-*.ts, which
 * download the (freely redistributable) releases and emit this same shape. UMLS/
 * SNOMED are user-supplied only (never bundled — license line).
 * Worker-safe (process.env via getDb()).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { conceptEdges, conceptEmbeddings, conceptSynonyms, concepts, ontologies, organizations } from '../db/schema';
import { embedText } from '../ai/embeddings';

export interface ConceptRecord {
	id: string;
	ontology: string;
	code: string;
	prefLabel: string;
	kind?: string;
	description?: string;
	synonyms?: string[];
}
export interface OntologyEdge {
	source: string;
	target: string;
	rel: string;
	weight?: number;
}
export interface OntologyData {
	concepts: ConceptRecord[];
	edges?: OntologyEdge[];
}

/** Import formats the admin endpoint accepts (mirrors what load.ts can parse). */
export const IMPORT_FORMATS = ['json', 'terms', 'obo'] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

export async function loadOntology(
	data: OntologyData
): Promise<{ concepts: number; synonyms: number; edges: number; embeddings: number }> {
	const db = getDb();
	if (!db) throw new Error('DATABASE_URL required to load an ontology');
	let synCount = 0;
	let embCount = 0;

	for (const c of data.concepts) {
		await db
			.insert(concepts)
			.values({ id: c.id, ontology: c.ontology, code: c.code, prefLabel: c.prefLabel, kind: c.kind ?? 'concept', description: c.description ?? '' })
			.onConflictDoNothing();

		const labels = [c.prefLabel, ...(c.synonyms ?? [])];
		for (let i = 0; i < labels.length; i++) {
			const label = labels[i];
			if (i > 0) {
				await db
					.insert(conceptSynonyms)
					.values({ id: `syn_${c.id}_${i}`, conceptId: c.id, synonym: label })
					.onConflictDoNothing();
				synCount++;
			}
			const emb = await embedText(label).catch(() => null);
			await db
				.insert(conceptEmbeddings)
				.values({ id: `ce_${c.id}_${i}`, conceptId: c.id, label, embedding: emb })
				.onConflictDoNothing();
			embCount++;
		}
	}

	let edgeCount = 0;
	for (const e of data.edges ?? []) {
		await db
			.insert(conceptEdges)
			.values({ id: `edge_${e.source}__${e.rel}__${e.target}`, sourceConceptId: e.source, targetConceptId: e.target, rel: e.rel, weight: e.weight ?? 1 })
			.onConflictDoNothing();
		edgeCount++;
	}

	return { concepts: data.concepts.length, synonyms: synCount, edges: edgeCount, embeddings: embCount };
}

const SEED_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'resources', 'ontologies', 'seed.json');

/** Load the bundled seed ontology. */
export async function seedOntology(): Promise<{ concepts: number; synonyms: number; edges: number; embeddings: number }> {
	const data = JSON.parse(readFileSync(SEED_PATH, 'utf8')) as OntologyData;
	return loadOntology(data);
}

// ── Import parsing (A11) ─────────────────────────────────────────────────────
// The admin Import modal posts raw text in one of three shapes. Each is parsed
// into the same OntologyData the CLI loader consumes, then loadOntology() runs.
// `ontology` (the target slug, e.g. 'custom') stamps every concept so counts and
// the schema view group correctly; concept ids are namespaced by that slug.

/** Strip the surfaced `ont_<slug>` id back to the concepts.ontology slug. */
export function ontologySlugFromId(id: string): string {
	return id.startsWith('ont_') ? id.slice(4) : id;
}

/** Slugify a free-text label into a safe concept-code component. */
function codeSlug(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 60);
}

/** Detect the most likely format when the caller doesn't specify one. */
export function detectImportFormat(raw: string): ImportFormat {
	const t = raw.trim();
	if (t.startsWith('{') || t.startsWith('[')) return 'json';
	if (/^\s*(format-version:|\[Term\]|id:\s)/m.test(t)) return 'obo';
	return 'terms';
}

export class OntologyParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'OntologyParseError';
	}
}

interface ParseOptions {
	ontology: string;
	format?: ImportFormat;
}

/**
 * Parse an uploaded ontology payload into loader shape. Throws
 * OntologyParseError (→ HTTP 400) on malformed input so the admin modal can show
 * an honest error instead of silently importing nothing.
 */
export function parseOntologyInput(raw: string, opts: ParseOptions): OntologyData {
	const text = (raw ?? '').trim();
	if (!text) throw new OntologyParseError('Empty ontology payload');
	const ontology = opts.ontology;
	const format = opts.format ?? detectImportFormat(text);

	if (format === 'json') return parseJsonPayload(text, ontology);
	if (format === 'obo') return { concepts: parseObo(text, ontology) };
	return { concepts: parseTermList(text, ontology) };
}

function parseJsonPayload(text: string, ontology: string): OntologyData {
	let doc: unknown;
	try {
		doc = JSON.parse(text);
	} catch (e) {
		throw new OntologyParseError(`Invalid JSON: ${e instanceof Error ? e.message : 'parse error'}`);
	}
	// Accept either the loader shape ({concepts,edges}) or a bare array of concepts.
	const rawConcepts = Array.isArray(doc)
		? doc
		: doc && typeof doc === 'object' && Array.isArray((doc as { concepts?: unknown }).concepts)
			? (doc as { concepts: unknown[] }).concepts
			: null;
	if (!rawConcepts) {
		throw new OntologyParseError('JSON must be a concepts array or an object with a "concepts" array');
	}

	const seen = new Set<string>();
	const concepts: ConceptRecord[] = [];
	for (const [i, c] of rawConcepts.entries()) {
		if (!c || typeof c !== 'object') continue;
		const rec = c as Record<string, unknown>;
		const prefLabel = String(rec.prefLabel ?? rec.name ?? rec.label ?? '').trim();
		if (!prefLabel) throw new OntologyParseError(`Concept #${i + 1} is missing a prefLabel/name`);
		const code = String(rec.code ?? rec.id ?? codeSlug(prefLabel)).trim() || codeSlug(prefLabel);
		const id = String(rec.id ?? `${ontology}:${code}`).trim() || `${ontology}:${code}`;
		if (seen.has(id)) continue;
		seen.add(id);
		const synonyms = Array.isArray(rec.synonyms)
			? rec.synonyms.map((s) => String(s).trim()).filter(Boolean)
			: [];
		concepts.push({
			id,
			ontology,
			code,
			prefLabel,
			kind: typeof rec.kind === 'string' && rec.kind.trim() ? rec.kind.trim() : 'concept',
			description: typeof rec.description === 'string' ? rec.description : '',
			synonyms
		});
	}
	if (!concepts.length) throw new OntologyParseError('No valid concepts found in JSON payload');

	// Edges are optional; keep only those whose endpoints resolve to parsed concepts.
	const rawEdges =
		!Array.isArray(doc) && doc && typeof doc === 'object' && Array.isArray((doc as { edges?: unknown }).edges)
			? ((doc as { edges: unknown[] }).edges as Record<string, unknown>[])
			: [];
	const edges: OntologyEdge[] = [];
	for (const e of rawEdges) {
		const source = String(e.source ?? '').trim();
		const target = String(e.target ?? '').trim();
		if (!source || !target || !seen.has(source) || !seen.has(target)) continue;
		edges.push({ source, target, rel: String(e.rel ?? 'related').trim() || 'related', weight: Number(e.weight ?? 1) || 1 });
	}
	return { concepts, edges };
}

/**
 * Simple term list: one concept per line. `preferredLabel | syn1; syn2` — the
 * pipe and everything after it are optional synonyms (semicolon-separated).
 * Blank lines and `#` comments are ignored.
 */
function parseTermList(text: string, ontology: string): ConceptRecord[] {
	const seen = new Set<string>();
	const out: ConceptRecord[] = [];
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const [labelPart, synPart] = trimmed.split('|');
		const prefLabel = labelPart.trim();
		if (!prefLabel) continue;
		const code = codeSlug(prefLabel);
		const id = `${ontology}:${code || `term-${out.length + 1}`}`;
		if (seen.has(id)) continue;
		seen.add(id);
		const synonyms = (synPart ?? '')
			.split(/[;,]/)
			.map((s) => s.trim())
			.filter(Boolean);
		out.push({ id, ontology, code: code || `term-${out.length + 1}`, prefLabel, kind: 'concept', description: '', synonyms });
	}
	if (!out.length) throw new OntologyParseError('No terms found (expected one concept per line)');
	return out;
}

/**
 * Minimal OBO 1.x parser: `[Term]` stanzas with `id:`, `name:`, `def:`,
 * `synonym:` and `is_a:` lines. Enough to ingest a hand-authored or trimmed OBO
 * export; ignores stanza types other than [Term] and unrecognized tags.
 */
function parseObo(text: string, ontology: string): ConceptRecord[] {
	const out: ConceptRecord[] = [];
	const seen = new Set<string>();
	let inTerm = false;
	let cur: ConceptRecord | null = null;

	const flush = () => {
		// Keep any named term; only dedupe on a real (non-empty) id so multiple
		// id-less stanzas aren't collapsed before the post-loop id backfill.
		if (cur && cur.prefLabel && (!cur.id || !seen.has(cur.id))) {
			if (cur.id) seen.add(cur.id);
			out.push(cur);
		}
		cur = null;
	};

	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.startsWith('[')) {
			flush();
			inTerm = trimmed === '[Term]';
			if (inTerm) cur = { id: '', ontology, code: '', prefLabel: '', kind: 'concept', description: '', synonyms: [] };
			continue;
		}
		if (!inTerm || !cur) continue;
		// Capture into a non-null local so control-flow narrowing holds (the flush
		// closure reassigns `cur`, which would otherwise widen it back to nullable).
		const term = cur;
		const idx = trimmed.indexOf(':');
		if (idx < 0) continue;
		const tag = trimmed.slice(0, idx).trim();
		const value = trimmed.slice(idx + 1).trim();
		if (tag === 'id') {
			term.code = value;
			term.id = `${ontology}:${value}`;
		} else if (tag === 'name') {
			term.prefLabel = value;
		} else if (tag === 'def') {
			// def: "text" [xrefs] → keep the quoted portion.
			const m = value.match(/"([^"]*)"/);
			term.description = m ? m[1] : value;
		} else if (tag === 'synonym') {
			const m = value.match(/"([^"]*)"/);
			if (m && m[1]) (term.synonyms ??= []).push(m[1]);
		}
	}
	flush();
	if (!out.length) throw new OntologyParseError('No [Term] stanzas with a name found in OBO input');
	// Guarantee ids for any term that had a name but no id line.
	for (const [i, c] of out.entries()) {
		if (!c.id) {
			c.code = codeSlug(c.prefLabel) || `term-${i + 1}`;
			c.id = `${ontology}:${c.code}`;
		}
	}
	return out;
}

// ── Ontology metadata bookkeeping (A11) ──────────────────────────────────────
// The `ontologies` table (per-org, surfaced by GET /api/ontologies fallback and
// the create flow) is refreshed from the real loaded concept counts so its
// entities/relations stop drifting from the dictionary.

/** Live concept + synonym counts for one ontology slug (0 when none loaded). */
export async function conceptCounts(ontology: string): Promise<{ entities: number; relations: number }> {
	const db = getDb();
	if (!db) return { entities: 0, relations: 0 };
	const res = await db.execute<{ entities: number; relations: number }>(sql`
		SELECT count(DISTINCT c.id)::int AS entities,
		       count(s.id)::int AS relations
		FROM concepts c
		LEFT JOIN concept_synonyms s ON s.concept_id = c.id
		WHERE c.ontology = ${ontology}
	`);
	const row = res.rows[0];
	return { entities: Number(row?.entities ?? 0), relations: Number(row?.relations ?? 0) };
}

/**
 * Create/refresh the ontologies metadata row for a slug, stamping the current
 * concept counts. Idempotent; ensures the org FK row exists first (same guard
 * the sources/org-settings writers use). Returns the metadata id (`ont_<slug>`).
 */
export async function upsertOntologyMeta(
	orgId: string,
	ontology: string,
	opts: { name?: string; status?: 'active' | 'draft' } = {}
): Promise<string> {
	const db = getDb();
	if (!db) throw new Error('Database required to persist ontology metadata');
	const id = `ont_${ontology}`;
	await db
		.insert(organizations)
		.values({ id: orgId, name: orgId, slug: orgId, tenantId: orgId })
		.onConflictDoNothing();

	const counts = await conceptCounts(ontology);
	const [existing] = await db.select().from(ontologies).where(eq(ontologies.id, id));
	const name = opts.name ?? existing?.name ?? ontology.toUpperCase();
	const status = opts.status ?? (existing?.status as 'active' | 'draft' | undefined) ?? (counts.entities > 0 ? 'active' : 'draft');
	const updatedAt = new Date();

	await db
		.insert(ontologies)
		.values({ id, orgId, name, entities: counts.entities, relations: counts.relations, status, updatedAt })
		.onConflictDoUpdate({
			target: ontologies.id,
			set: { name, entities: counts.entities, relations: counts.relations, status, updatedAt, orgId }
		});
	return id;
}

/**
 * Parse + persist an uploaded ontology and refresh its metadata row. This is the
 * single import entry point shared by the synchronous route path (and reusable
 * by a background job). Returns loader counts plus the resolved slug/meta id.
 */
export async function importOntology(
	orgId: string,
	raw: string,
	opts: { ontology: string; name?: string; format?: ImportFormat }
): Promise<{ ontology: string; ontologyId: string; concepts: number; synonyms: number; edges: number; embeddings: number }> {
	const data = parseOntologyInput(raw, { ontology: opts.ontology, format: opts.format });
	const loaded = await loadOntology(data);
	const ontologyId = await upsertOntologyMeta(orgId, opts.ontology, {
		name: opts.name,
		status: 'active'
	});
	return { ontology: opts.ontology, ontologyId, ...loaded };
}
