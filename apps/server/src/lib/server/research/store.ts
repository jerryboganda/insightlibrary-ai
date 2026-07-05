/**
 * Research suite persistence (gap B10).
 *
 * The entire Research suite — the hub plus the four tools (argument map, compare
 * matrix, report builder, timeline builder) — was previously a static mockup with
 * ZERO backend. This module is its real store: ONE `research_projects` table
 * serves all four tools, with the tool-specific document held in a typed `data`
 * JSONB blob discriminated by `type`.
 *
 * Design notes:
 *  - The research_projects pgTable is defined HERE (migration 0012) because
 *    db/schema.ts is not owned by this lane; Drizzle's query builder works with
 *    any table object. Fold into db/schema.ts when convenient (recorded followUp).
 *  - Worker-safe: getDb()/process.env only. All reads/writes go through getDb();
 *    when no DATABASE_URL is set the routes surface an honest empty/503 state
 *    rather than pretending to persist (the old setTimeout fakes are gone).
 *  - The `data` shapes below are the honest contract the tool pages read/write.
 *    They are validated with Zod at the write boundary (routes) so a project can
 *    never hold a payload the UI can't render.
 */
import { and, desc, eq } from 'drizzle-orm';
import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { getDb } from '../db/client';

/** Per-org research projects. ONE row per saved tool document. Migration 0012. */
export const researchProjects = pgTable('research_projects', {
	id: text('id').primaryKey(),
	orgId: text('org_id').notNull(),
	/** argument_map | compare_matrix | report | timeline */
	type: text('type').notNull(),
	title: text('title').notNull(),
	data: jsonb('data').$type<ResearchData>().notNull().default({} as ResearchData),
	createdBy: text('created_by'),
	createdAt: timestamp('created_at').notNull().defaultNow(),
	updatedAt: timestamp('updated_at').notNull().defaultNow()
});

// ── Project types ────────────────────────────────────────────────────────────

export const RESEARCH_TYPES = ['argument_map', 'compare_matrix', 'report', 'timeline'] as const;
export type ResearchType = (typeof RESEARCH_TYPES)[number];

export function isResearchType(v: unknown): v is ResearchType {
	return typeof v === 'string' && (RESEARCH_TYPES as readonly string[]).includes(v);
}

// ── Tool-specific `data` blobs (the honest read/write contract) ──────────────

/** Argument map: premise/evidence/conclusion nodes in top-to-bottom order. */
export interface ArgumentMapNode {
	id: string;
	kind: 'premise' | 'evidence' | 'conclusion';
	label: string;
	text: string;
	/** Citation token — a source ref (e.g. 'bk-A'), claim id, or free text. */
	source?: string;
}
export interface ArgumentMapData {
	nodes: ArgumentMapNode[];
}

/** Compare matrix: concept rows × source columns. tone flags agreement/conflict. */
export type MatrixCellTone = 'default' | 'agree' | 'conflict' | 'missing';
export interface MatrixCell {
	text: string;
	tone?: MatrixCellTone;
}
export interface MatrixRow {
	id: string;
	concept: string;
	/** One cell per column, index-aligned to `columns`. */
	cells: MatrixCell[];
}
export interface CompareMatrixData {
	/** Column headers — seeded from the source registry when available. */
	columns: string[];
	rows: MatrixRow[];
}

/** Report builder: a Copilot-orchestrated cited synthesis document. */
export interface ReportSource {
	id: string;
	label: string;
	/** Optional topic id when the source is an SSOT topic (enables real grounding). */
	topicId?: string;
}
export interface ReportData {
	prompt: string;
	strictCitation: boolean;
	sources: ReportSource[];
	/** Markdown body — empty until generated/edited. */
	body: string;
	/** Provenance of the current body: how it was produced. */
	generatedBy?: 'ai' | 'manual' | 'fallback';
	generatedAt?: string;
	wordCount?: number;
	citationCount?: number;
}

/** Timeline builder: ordered chronological events. */
export interface TimelineEvent {
	id: string;
	phase: string;
	stage: string;
	description: string;
	tone: 'default' | 'critical';
}
export interface TimelineData {
	events: TimelineEvent[];
}

export type ResearchData =
	| ArgumentMapData
	| CompareMatrixData
	| ReportData
	| TimelineData
	| Record<string, never>;

/** Empty starting document for a freshly created project of each type. */
export function emptyData(type: ResearchType): ResearchData {
	switch (type) {
		case 'argument_map':
			return { nodes: [] } satisfies ArgumentMapData;
		case 'compare_matrix':
			return { columns: [], rows: [] } satisfies CompareMatrixData;
		case 'report':
			return { prompt: '', strictCitation: true, sources: [], body: '' } satisfies ReportData;
		case 'timeline':
			return { events: [] } satisfies TimelineData;
	}
}

// ── Row → wire shape ─────────────────────────────────────────────────────────

export interface ResearchProject {
	id: string;
	type: ResearchType;
	title: string;
	data: ResearchData;
	createdAt: string;
	updatedAt: string;
}

type Row = typeof researchProjects.$inferSelect;

export function toProject(row: Row): ResearchProject {
	return {
		id: row.id,
		type: isResearchType(row.type) ? row.type : 'report',
		title: row.title,
		data: (row.data ?? {}) as ResearchData,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString()
	};
}

// ── Store operations (all no-op / empty when no DB) ──────────────────────────

let seq = 0;
function newId(): string {
	seq = (seq + 1) % 1_000_000;
	return `rp_${Date.now().toString(36)}_${seq.toString(36)}`;
}

/** List an org's projects, optionally filtered by type, newest-updated first. */
export async function listProjects(
	orgId: string,
	type?: ResearchType
): Promise<ResearchProject[]> {
	const db = getDb();
	if (!db) return [];
	const where = type
		? and(eq(researchProjects.orgId, orgId), eq(researchProjects.type, type))
		: eq(researchProjects.orgId, orgId);
	const rows = await db
		.select()
		.from(researchProjects)
		.where(where)
		.orderBy(desc(researchProjects.updatedAt));
	return rows.map(toProject);
}

/** Fetch one project scoped to its org (null if missing or cross-org). */
export async function getProject(orgId: string, id: string): Promise<ResearchProject | null> {
	const db = getDb();
	if (!db) return null;
	const [row] = await db.select().from(researchProjects).where(eq(researchProjects.id, id));
	if (!row || row.orgId !== orgId) return null;
	return toProject(row);
}

export async function createProject(input: {
	orgId: string;
	type: ResearchType;
	title: string;
	data?: ResearchData;
	createdBy?: string | null;
}): Promise<ResearchProject | null> {
	const db = getDb();
	if (!db) return null;
	const now = new Date();
	const [row] = await db
		.insert(researchProjects)
		.values({
			id: newId(),
			orgId: input.orgId,
			type: input.type,
			title: input.title,
			data: input.data ?? emptyData(input.type),
			createdBy: input.createdBy ?? null,
			createdAt: now,
			updatedAt: now
		})
		.returning();
	return row ? toProject(row) : null;
}

/** Patch title and/or data. Returns the updated project, or null if not found. */
export async function updateProject(
	orgId: string,
	id: string,
	patch: { title?: string; data?: ResearchData }
): Promise<ResearchProject | null> {
	const db = getDb();
	if (!db) return null;
	const [existing] = await db.select().from(researchProjects).where(eq(researchProjects.id, id));
	if (!existing || existing.orgId !== orgId) return null;
	const set: Partial<typeof researchProjects.$inferInsert> = { updatedAt: new Date() };
	if (patch.title !== undefined) set.title = patch.title;
	if (patch.data !== undefined) set.data = patch.data;
	const [row] = await db
		.update(researchProjects)
		.set(set)
		.where(eq(researchProjects.id, id))
		.returning();
	return row ? toProject(row) : null;
}

export async function deleteProject(orgId: string, id: string): Promise<boolean> {
	const db = getDb();
	if (!db) return false;
	const [existing] = await db.select().from(researchProjects).where(eq(researchProjects.id, id));
	if (!existing || existing.orgId !== orgId) return false;
	await db.delete(researchProjects).where(eq(researchProjects.id, id));
	return true;
}
