/**
 * Ontology schema editor persistence (gap B23).
 *
 * The admin schema editor (admin/ontology/[id]) has three editable layers that
 * are NOT stored concepts: the entity/class list, per-entity properties, and the
 * per-entity auto-merge (conflict) strategy. They live here, per-org, keyed by
 * the ontology slug that concepts.ontology already groups by.
 *
 * Read model:
 *   - getOntologySchema() ALWAYS returns real, honest data. It reads the stored
 *     editable overlay (if any) and merges it with a live view synthesized from
 *     the concepts dictionary: real per-kind counts and sample concepts/synonyms
 *     for the ontology. When nothing has been edited yet, the editor shows the
 *     genuine concept structure (read-only-truthful) rather than a hardcoded one.
 *
 * SCHEMA-OWNERSHIP NOTE: schema.ts is not owned by this lane, so the Drizzle
 * table is defined here (co-located) and the physical table is created in
 * migrations/0013_ontology_schema.sql. Fold `ontologySchemas` into schema.ts
 * later (recorded as a followUp). Worker-safe (getDb()/process.env only).
 */
import { eq, and, sql } from 'drizzle-orm';
import { jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { getDb } from '../db/client';
import { organizations } from '../db/schema';
import { ontologySlugFromId } from './load';

export interface SchemaProperty {
	id: string;
	name: string;
	type: string;
	required: boolean;
	desc: string;
}
export interface SchemaEntity {
	id: string;
	name: string;
	/** 'append' = merge variants automatically; 'review' = queue for a human. */
	mergeStrategy: 'append' | 'review';
	properties: SchemaProperty[];
}
export interface EditableSchema {
	entities: SchemaEntity[];
}

/** A concept kind (concepts.kind) with its real count + a few sample concepts. */
export interface ConceptKindSummary {
	kind: string;
	count: number;
	samples: { id: string; prefLabel: string; synonyms: string[] }[];
}

export interface OntologySchemaView {
	id: string; // 'ont_<slug>'
	ontology: string; // slug
	name: string;
	status: 'active' | 'draft';
	/** True when an editable overlay has been saved (vs. concept-derived only). */
	stored: boolean;
	/** Real dictionary structure for this ontology (always populated). */
	conceptKinds: ConceptKindSummary[];
	conceptTotal: number;
	synonymTotal: number;
	/** Editable entity/property/merge layer (defaults derived from conceptKinds). */
	schema: EditableSchema;
	updatedAt: string | null;
}

/** Co-located table (see module note); physical DDL in 0013_ontology_schema.sql. */
export const ontologySchemas = pgTable(
	'ontology_schemas',
	{
		orgId: text('org_id')
			.notNull()
			.references(() => organizations.id),
		ontology: text('ontology').notNull(),
		name: text('name'),
		status: text('status').notNull().default('draft'),
		schema: jsonb('schema').$type<EditableSchema>().notNull().default({ entities: [] }),
		updatedAt: timestamp('updated_at').notNull().defaultNow()
	},
	(t) => [primaryKey({ columns: [t.orgId, t.ontology] })]
);

const KIND_LABELS: Record<string, string> = {
	disease: 'Disease / Condition',
	drug: 'Drug / Treatment',
	phenotype: 'Phenotype / Finding',
	anatomy: 'Anatomy',
	procedure: 'Procedure',
	concept: 'Concept'
};

function titleCase(s: string): string {
	return s
		.replace(/[_-]+/g, ' ')
		.replace(/\b\w/g, (m) => m.toUpperCase())
		.trim();
}

/** Synthesize real per-kind structure from the concepts dictionary. */
async function conceptStructure(ontology: string): Promise<{
	kinds: ConceptKindSummary[];
	conceptTotal: number;
	synonymTotal: number;
}> {
	const db = getDb();
	if (!db) return { kinds: [], conceptTotal: 0, synonymTotal: 0 };

	const kindRows = await db.execute<{ kind: string; count: number }>(sql`
		SELECT c.kind, count(*)::int AS count
		FROM concepts c
		WHERE c.ontology = ${ontology}
		GROUP BY c.kind
		ORDER BY count DESC, c.kind ASC
	`);

	const kinds: ConceptKindSummary[] = [];
	let conceptTotal = 0;
	for (const kr of kindRows.rows) {
		conceptTotal += Number(kr.count);
		// A few real sample concepts + their synonyms for this kind.
		const samples = await db.execute<{ id: string; pref_label: string; synonyms: string[] | null }>(sql`
			SELECT c.id, c.pref_label,
			       (SELECT array_agg(s.synonym) FROM concept_synonyms s WHERE s.concept_id = c.id) AS synonyms
			FROM concepts c
			WHERE c.ontology = ${ontology} AND c.kind = ${kr.kind}
			ORDER BY c.pref_label ASC
			LIMIT 5
		`);
		kinds.push({
			kind: kr.kind,
			count: Number(kr.count),
			samples: samples.rows.map((r) => ({
				id: r.id,
				prefLabel: r.pref_label,
				synonyms: (r.synonyms ?? []).filter(Boolean)
			}))
		});
	}

	const synRes = await db.execute<{ n: number }>(sql`
		SELECT count(s.id)::int AS n
		FROM concept_synonyms s JOIN concepts c ON c.id = s.concept_id
		WHERE c.ontology = ${ontology}
	`);

	return { kinds, conceptTotal, synonymTotal: Number(synRes.rows[0]?.n ?? 0) };
}

/** Default editable entities derived from the real concept kinds. */
function defaultEntities(kinds: ConceptKindSummary[]): SchemaEntity[] {
	return kinds.map((k) => ({
		id: `ent_${k.kind}`,
		name: KIND_LABELS[k.kind] ?? titleCase(k.kind),
		mergeStrategy: 'append' as const,
		properties: []
	}));
}

/**
 * Full schema view for an ontology id (`ont_<slug>` or a raw slug). Always
 * returns real dictionary structure; overlays a saved editable schema if present.
 */
export async function getOntologySchema(idOrSlug: string, orgId = 'org_1'): Promise<OntologySchemaView> {
	const ontology = ontologySlugFromId(idOrSlug);
	const { kinds, conceptTotal, synonymTotal } = await conceptStructure(ontology);

	let stored = false;
	let name = KIND_LABELS[ontology] ?? ontology.toUpperCase();
	let status: 'active' | 'draft' = conceptTotal > 0 ? 'active' : 'draft';
	let schema: EditableSchema = { entities: defaultEntities(kinds) };
	let updatedAt: string | null = null;

	const db = getDb();
	if (db) {
		try {
			const [row] = await db
				.select()
				.from(ontologySchemas)
				.where(and(eq(ontologySchemas.orgId, orgId), eq(ontologySchemas.ontology, ontology)));
			if (row) {
				stored = true;
				name = row.name ?? name;
				status = (row.status as 'active' | 'draft') ?? status;
				updatedAt = row.updatedAt.toISOString();
				const savedEntities = Array.isArray(row.schema?.entities) ? row.schema.entities : [];
				if (savedEntities.length) schema = { entities: savedEntities };
			}
		} catch (e) {
			// Table missing (pre-0013) or transient blip → concept-derived view.
			console.error('[ontology-schema] read failed:', e instanceof Error ? e.message : e);
		}
	}

	return {
		id: `ont_${ontology}`,
		ontology,
		name,
		status,
		stored,
		conceptKinds: kinds,
		conceptTotal,
		synonymTotal,
		schema,
		updatedAt
	};
}

// ── Write path (validated; admin endpoint only) ─────────────────────────────

function sanitizeProperty(p: unknown, i: number): SchemaProperty | null {
	if (!p || typeof p !== 'object') return null;
	const r = p as Record<string, unknown>;
	const name = String(r.name ?? '').trim();
	if (!name) return null;
	return {
		id: String(r.id ?? `prop_${i + 1}`).slice(0, 80),
		name: name.slice(0, 120),
		type: String(r.type ?? 'String').slice(0, 60) || 'String',
		required: r.required === true,
		desc: String(r.desc ?? '').slice(0, 500)
	};
}

function sanitizeEntity(e: unknown, i: number): SchemaEntity | null {
	if (!e || typeof e !== 'object') return null;
	const r = e as Record<string, unknown>;
	const name = String(r.name ?? '').trim();
	if (!name) return null;
	const rawProps = Array.isArray(r.properties) ? r.properties : [];
	return {
		id: String(r.id ?? `ent_${i + 1}`).slice(0, 80),
		name: name.slice(0, 120),
		mergeStrategy: r.mergeStrategy === 'review' ? 'review' : 'append',
		properties: rawProps.map(sanitizeProperty).filter((p): p is SchemaProperty => p !== null).slice(0, 100)
	};
}

export interface SchemaUpdate {
	name?: string;
	status?: 'active' | 'draft';
	schema?: { entities?: unknown[] };
}

/** Persist editor changes. Returns the refreshed full view. */
export async function saveOntologySchema(
	idOrSlug: string,
	orgId: string,
	update: SchemaUpdate
): Promise<OntologySchemaView> {
	const db = getDb();
	if (!db) throw new Error('Database required to persist ontology schema');
	const ontology = ontologySlugFromId(idOrSlug);

	// FK guard (matches sources/org-settings): ensure the org row exists.
	await db
		.insert(organizations)
		.values({ id: orgId, name: orgId, slug: orgId, tenantId: orgId })
		.onConflictDoNothing();

	const [existing] = await db
		.select()
		.from(ontologySchemas)
		.where(and(eq(ontologySchemas.orgId, orgId), eq(ontologySchemas.ontology, ontology)));

	const entities = Array.isArray(update.schema?.entities)
		? update.schema!.entities.map(sanitizeEntity).filter((e): e is SchemaEntity => e !== null).slice(0, 200)
		: ((existing?.schema?.entities as SchemaEntity[] | undefined) ?? []);

	const name = update.name !== undefined ? update.name.trim().slice(0, 120) || null : (existing?.name ?? null);
	const status: 'active' | 'draft' =
		update.status === 'active' || update.status === 'draft'
			? update.status
			: ((existing?.status as 'active' | 'draft') ?? 'draft');
	const updatedAt = new Date();

	await db
		.insert(ontologySchemas)
		.values({ orgId, ontology, name, status, schema: { entities }, updatedAt })
		.onConflictDoUpdate({
			target: [ontologySchemas.orgId, ontologySchemas.ontology],
			set: { name, status, schema: { entities }, updatedAt }
		});

	return getOntologySchema(ontology, orgId);
}
