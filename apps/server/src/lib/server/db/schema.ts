import {
	boolean,
	doublePrecision,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	real,
	text,
	timestamp,
	vector
} from 'drizzle-orm/pg-core';

// better-auth's tables (user/session/account/verification + org plugin), emitted
// by `@better-auth/cli generate`. Re-exported so `drizzle-kit push` creates them
// and the better-auth drizzle adapter resolves them.
export * from './auth-schema';

/**
 * Drizzle schema — the production Postgres model mirroring @insightlibrary/schemas.
 * pgvector powers semantic search over document chunks; Postgres FTS (a generated
 * tsvector + GIN index, added in a migration) powers lexical search. Hybrid
 * ranking (RRF) combines them at query time.
 */

// ── Tenancy & identity ─────────────────────────────────────────────────────
export const organizations = pgTable('organizations', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	slug: text('slug').notNull().unique(),
	tenantId: text('tenant_id').notNull(),
	createdAt: timestamp('created_at').notNull().defaultNow()
});

export const users = pgTable('users', {
	id: text('id').primaryKey(),
	orgId: text('org_id')
		.notNull()
		.references(() => organizations.id),
	name: text('name').notNull(),
	email: text('email').notNull().unique(),
	role: text('role').notNull().default('viewer'),
	initials: text('initials').notNull().default(''),
	lastActiveAt: timestamp('last_active_at').notNull().defaultNow()
});

// ── Library ─────────────────────────────────────────────────────────────────
export const folders = pgTable('folders', {
	id: text('id').primaryKey(),
	orgId: text('org_id')
		.notNull()
		.references(() => organizations.id),
	name: text('name').notNull(),
	health: integer('health').notNull().default(100),
	createdAt: timestamp('created_at').notNull().defaultNow(),
	updatedAt: timestamp('updated_at').notNull().defaultNow()
});

export const documents = pgTable('documents', {
	id: text('id').primaryKey(),
	folderId: text('folder_id')
		.notNull()
		.references(() => folders.id),
	title: text('title').notNull(),
	status: text('status').notNull().default('processing'),
	statusLabel: text('status_label').notNull().default('Queued'),
	type: text('type').notNull(),
	pages: integer('pages').notNull().default(0),
	storageKey: text('storage_key'),
	uploadedAt: timestamp('uploaded_at').notNull().defaultNow()
});

/** Embedded chunks: hybrid FTS (tsvector generated in migration) + pgvector. */
export const chunks = pgTable('chunks', {
	id: text('id').primaryKey(),
	documentId: text('document_id')
		.notNull()
		.references(() => documents.id),
	page: integer('page'),
	content: text('content').notNull(),
	// gemini-embedding-001 truncated to 768 dims (MRL); halfvec in prod for storage.
	embedding: vector('embedding', { dimensions: 768 })
});

export const sources = pgTable('sources', {
	id: text('id').primaryKey(),
	orgId: text('org_id')
		.notNull()
		.references(() => organizations.id),
	name: text('name').notNull(),
	author: text('author').notNull(),
	type: text('type').notNull(),
	priority: integer('priority').notNull().default(3),
	date: text('date').notNull()
});

// ── SSOT / topics ───────────────────────────────────────────────────────────
export const topics = pgTable('topics', {
	id: text('id').primaryKey(),
	orgId: text('org_id')
		.notNull()
		.references(() => organizations.id),
	name: text('name').notNull(),
	aliases: jsonb('aliases').$type<string[]>().notNull().default([]),
	health: integer('health').notNull().default(100),
	updates: integer('updates').notNull().default(0),
	folder: text('folder').notNull().default(''),
	/** SSOT sections+claims stored as JSONB; normalized further if needed. */
	sections: jsonb('sections').$type<unknown[]>().notNull().default([]),
	updatedAt: timestamp('updated_at').notNull().defaultNow()
});

export const reviewItems = pgTable('review_items', {
	id: text('id').primaryKey(),
	orgId: text('org_id')
		.notNull()
		.references(() => organizations.id),
	topic: text('topic').notNull(),
	type: text('type').notNull(),
	status: text('status').notNull().default('pending'),
	originalClaim: text('original_claim'),
	newClaim: text('new_claim').notNull(),
	sourceA: text('source_a'),
	sourceB: text('source_b').notNull(),
	confidence: text('confidence').notNull(),
	notes: text('notes').notNull().default('')
});

export const flashcards = pgTable('flashcards', {
	id: text('id').primaryKey(),
	topicId: text('topic_id')
		.notNull()
		.references(() => topics.id),
	topic: text('topic').notNull(),
	front: text('front').notNull(),
	back: text('back').notNull()
});

// ── Graph ─────────────────────────────────────────────────────────────────
export const graphNodes = pgTable('graph_nodes', {
	id: text('id').notNull(),
	orgId: text('org_id')
		.notNull()
		.references(() => organizations.id),
	group: text('group').notNull(),
	size: integer('size').notNull().default(10)
}, (t) => [primaryKey({ columns: [t.orgId, t.id] })]);

export const graphEdges = pgTable('graph_edges', {
	id: text('id').primaryKey(),
	orgId: text('org_id')
		.notNull()
		.references(() => organizations.id),
	source: text('source').notNull(),
	target: text('target').notNull(),
	label: text('label').notNull()
});

// ── Admin ─────────────────────────────────────────────────────────────────
export const processingJobs = pgTable('processing_jobs', {
	id: text('id').primaryKey(),
	documentId: text('document_id').notNull(),
	documentTitle: text('document_title').notNull(),
	stage: text('stage').notNull().default('queued'),
	progress: real('progress').notNull().default(0),
	message: text('message').notNull().default(''),
	startedAt: timestamp('started_at').notNull().defaultNow()
});

export const auditLogs = pgTable('audit_logs', {
	id: text('id').primaryKey(),
	orgId: text('org_id')
		.notNull()
		.references(() => organizations.id),
	actor: text('actor').notNull(),
	action: text('action').notNull(),
	target: text('target').notNull(),
	severity: text('severity').notNull().default('info'),
	timestamp: timestamp('timestamp').notNull().defaultNow()
});

export const ontologies = pgTable('ontologies', {
	id: text('id').primaryKey(),
	orgId: text('org_id')
		.notNull()
		.references(() => organizations.id),
	name: text('name').notNull(),
	entities: integer('entities').notNull().default(0),
	relations: integer('relations').notNull().default(0),
	status: text('status').notNull().default('draft'),
	updatedAt: timestamp('updated_at').notNull().defaultNow()
});

export const notifications = pgTable('notifications', {
	id: text('id').primaryKey(),
	orgId: text('org_id')
		.notNull()
		.references(() => organizations.id),
	type: text('type').notNull(),
	title: text('title').notNull(),
	description: text('description').notNull(),
	action: text('action'),
	read: boolean('read').notNull().default(false),
	createdAt: timestamp('created_at').notNull().defaultNow()
});

/** Aggregated usage metering (one row per org per period in production). */
export const usageMetrics = pgTable('usage_metrics', {
	orgId: text('org_id')
		.primaryKey()
		.references(() => organizations.id),
	monthlyBudget: doublePrecision('monthly_budget').notNull().default(0),
	currentSpend: doublePrecision('current_spend').notNull().default(0),
	queries: integer('queries').notNull().default(0),
	costPerQuery: doublePrecision('cost_per_query').notNull().default(0),
	activeUsers: integer('active_users').notNull().default(0),
	storageGb: doublePrecision('storage_gb').notNull().default(0),
	events: jsonb('events').$type<unknown[]>().notNull().default([])
});
