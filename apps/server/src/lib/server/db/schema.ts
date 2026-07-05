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
	status: text('status').notNull().default('active'),
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
	// Contextual-retrieval prefix (Anthropic method): a short LLM-generated line
	// situating the chunk in its document; embedded with the content and (Phase 3)
	// weighted into the FTS tsvector. Nullable when no provider is configured.
	context: text('context'),
	/** Anchors the chunk to its source block (doc_blocks.id) when known. */
	blockId: text('block_id'),
	// gemini-embedding-001 truncated to 768 dims (MRL); halfvec in prod for storage.
	embedding: vector('embedding', { dimensions: 768 })
});

/** Structure-aware parse output: pages + blocks with coverage accounting. */
export const docPages = pgTable('doc_pages', {
	id: text('id').primaryKey(),
	documentId: text('document_id').notNull().references(() => documents.id),
	pageNo: integer('page_no').notNull(),
	width: real('width'),
	height: real('height'),
	status: text('status').notNull().default('parsed')
});

export const docBlocks = pgTable('doc_blocks', {
	id: text('id').primaryKey(),
	documentId: text('document_id').notNull().references(() => documents.id),
	pageNo: integer('page_no').notNull(),
	kind: text('kind').notNull().default('text'),
	bbox: jsonb('bbox').$type<[number, number, number, number] | null>(),
	readingOrder: integer('reading_order').notNull().default(0),
	content: text('content').notNull(),
	chunkId: text('chunk_id'),
	/** unaccounted | chunked | claimed | ignored | low_confidence | needs_review */
	coverageStatus: text('coverage_status').notNull().default('unaccounted'),
	confidence: real('confidence').notNull().default(0.6)
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
	back: text('back').notNull(),
	// Spaced-repetition scheduling (FSRS/SM-2 compatible). Existing bare cards
	// default to state='new' / due-now.
	sourceClaimId: text('source_claim_id'),
	dueAt: timestamp('due_at'),
	intervalDays: real('interval_days').notNull().default(0),
	easeFactor: real('ease_factor').notNull().default(2.5),
	stability: real('stability').notNull().default(0),
	difficulty: real('difficulty').notNull().default(0),
	repetitions: integer('repetitions').notNull().default(0),
	lapses: integer('lapses').notNull().default(0),
	lastReviewedAt: timestamp('last_reviewed_at'),
	state: text('state').notNull().default('new')
});

// ── Graph ─────────────────────────────────────────────────────────────────
export const graphNodes = pgTable('graph_nodes', {
	id: text('id').notNull(),
	orgId: text('org_id')
		.notNull()
		.references(() => organizations.id),
	group: text('group').notNull(),
	size: integer('size').notNull().default(10),
	// Semantic knowledge-graph fields (existing {id,group,size} reads unaffected).
	kind: text('kind').notNull().default('concept'),
	label: text('label').notNull().default(''),
	canonicalConceptId: text('canonical_concept_id'),
	description: text('description').notNull().default('')
}, (t) => [primaryKey({ columns: [t.orgId, t.id] })]);

export const graphEdges = pgTable('graph_edges', {
	id: text('id').primaryKey(),
	orgId: text('org_id')
		.notNull()
		.references(() => organizations.id),
	source: text('source').notNull(),
	target: text('target').notNull(),
	label: text('label').notNull(),
	// Semantic edge fields (existing {source,target,label} reads unaffected).
	rel: text('rel').notNull().default(''),
	weight: real('weight').notNull().default(1),
	sourceClaimId: text('source_claim_id')
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

// ── Refinery: first-class claims + provenance ───────────────────────────────
// Atomic, source-grounded claims. The topics.sections JSONB stays the live SSOT
// during transition; these normalized rows are dual-written by addClaim() and
// seeded once by jobs/backfill-claims.ts. normalized_meaning shares the 768-dim
// Gemini MRL space with chunks.embedding (never reindex either).
export const claims = pgTable('claims', {
	id: text('id').primaryKey(),
	orgId: text('org_id').notNull().references(() => organizations.id),
	topicId: text('topic_id').references(() => topics.id),
	sectionId: text('section_id'),
	/** mirrors the JSONB claim id (e.g. 'c3') for round-trip reconciliation */
	jsonbClaimId: text('jsonb_claim_id'),
	documentId: text('document_id').references(() => documents.id),
	claimType: text('claim_type').notNull().default('fact'),
	claimText: text('claim_text').notNull(),
	normalizedMeaning: vector('normalized_meaning', { dimensions: 768 }),
	ontologyIds: jsonb('ontology_ids').$type<string[]>().notNull().default([]),
	systemTags: jsonb('system_tags').$type<string[]>().notNull().default([]),
	examTags: jsonb('exam_tags').$type<string[]>().notNull().default([]),
	confidence: real('confidence').notNull().default(0.5),
	status: text('status').notNull().default('active'),
	supersedesClaimId: text('supersedes_claim_id'),
	createdAt: timestamp('created_at').notNull().defaultNow(),
	updatedAt: timestamp('updated_at').notNull().defaultNow()
});

export const claimSources = pgTable('claim_sources', {
	id: text('id').primaryKey(),
	claimId: text('claim_id').notNull().references(() => claims.id),
	sourceId: text('source_id').references(() => sources.id),
	/** raw citation token (e.g. 'bk-A') preserved when it isn't a real source row */
	sourceRef: text('source_ref'),
	locator: text('locator'),
	documentId: text('document_id').references(() => documents.id),
	chunkId: text('chunk_id').references(() => chunks.id),
	/** anchors to doc_blocks.id (Phase 1); falls back to a chunk id */
	blockId: text('block_id'),
	stance: text('stance').notNull().default('supports')
});

// Versioned snapshots of a topic's SSOT (union of composer + correlation needs).
export const topicVersions = pgTable('topic_versions', {
	id: text('id').primaryKey(),
	topicId: text('topic_id').notNull().references(() => topics.id),
	orgId: text('org_id').notNull().references(() => organizations.id),
	version: integer('version').notNull(),
	pageMd: text('page_md').notNull().default(''),
	sectionsSnapshot: jsonb('sections_snapshot').$type<unknown[]>().notNull().default([]),
	changelog: jsonb('changelog').$type<{ type: string; text: string; details: string }[]>().notNull().default([]),
	faithfulness: real('faithfulness'),
	createdBy: text('created_by'),
	createdAt: timestamp('created_at').notNull().defaultNow()
});

// Exam engine: generated MCQs / vignettes, linked to claims for citation inheritance.
export const mcqs = pgTable('mcqs', {
	id: text('id').primaryKey(),
	orgId: text('org_id').notNull().references(() => organizations.id),
	topicId: text('topic_id').notNull().references(() => topics.id),
	claimId: text('claim_id').references(() => claims.id),
	stem: text('stem').notNull(),
	options: jsonb('options').$type<{ id: string; text: string }[]>().notNull().default([]),
	correctOptionId: text('correct_option_id').notNull(),
	explanation: text('explanation').notNull().default(''),
	difficulty: text('difficulty').notNull().default('medium'),
	examTags: jsonb('exam_tags').$type<string[]>().notNull().default([]),
	status: text('status').notNull().default('draft'),
	createdAt: timestamp('created_at').notNull().defaultNow()
});

// ── Multi-provider LLM credentials & routing ────────────────────────────────
// Per-org keys (encrypted at rest with MASTER_ENCRYPTION_KEY). Desktop keys live
// in the OS keyring, not here. UNIQUE(org_id, provider) enforced in migration.
export const providerKeys = pgTable('provider_keys', {
	id: text('id').primaryKey(),
	orgId: text('org_id').notNull().references(() => organizations.id),
	provider: text('provider').notNull(),
	apiKeyEnc: text('api_key_enc').notNull(),
	baseUrl: text('base_url'),
	model: text('model'),
	hint: text('hint').notNull().default(''),
	createdAt: timestamp('created_at').notNull().defaultNow(),
	updatedAt: timestamp('updated_at').notNull().defaultNow()
});

export const providerSettings = pgTable('provider_settings', {
	orgId: text('org_id').primaryKey().references(() => organizations.id),
	defaultProvider: text('default_provider'),
	taskRouting: jsonb('task_routing').$type<Record<string, string>>().notNull().default({}),
	updatedAt: timestamp('updated_at').notNull().defaultNow()
});

// Per-user BYO keys for the WEB app (no OS keyring in a browser). Encrypted.
export const userAiCredentials = pgTable('user_ai_credentials', {
	id: text('id').primaryKey(),
	userId: text('user_id').notNull(),
	provider: text('provider').notNull(),
	apiKeyEnc: text('api_key_enc').notNull(),
	baseUrl: text('base_url'),
	model: text('model'),
	hint: text('hint').notNull().default(''),
	createdAt: timestamp('created_at').notNull().defaultNow(),
	updatedAt: timestamp('updated_at').notNull().defaultNow()
});

// ── Ontology grounding (MeSH / Mondo / HPO / RxNorm + user-supplied UMLS/SNOMED)
// Shared concept dictionary (not org-scoped). Loaded from bundled resources.
export const concepts = pgTable('concepts', {
	id: text('id').primaryKey(), // e.g. 'mondo:MONDO:0008170'
	ontology: text('ontology').notNull(), // mesh | mondo | hpo | rxnorm | umls | snomed | custom
	code: text('code').notNull(),
	prefLabel: text('pref_label').notNull(),
	kind: text('kind').notNull().default('concept'),
	description: text('description').notNull().default('')
});

export const conceptSynonyms = pgTable('concept_synonyms', {
	id: text('id').primaryKey(),
	conceptId: text('concept_id').notNull().references(() => concepts.id),
	synonym: text('synonym').notNull(),
	source: text('source').notNull().default('ontology')
});

export const conceptEdges = pgTable('concept_edges', {
	id: text('id').primaryKey(),
	sourceConceptId: text('source_concept_id').notNull().references(() => concepts.id),
	targetConceptId: text('target_concept_id').notNull().references(() => concepts.id),
	rel: text('rel').notNull().default('is_a'),
	weight: real('weight').notNull().default(1)
});

// One embedding row per label/synonym → nearest-neighbor entity linking.
export const conceptEmbeddings = pgTable('concept_embeddings', {
	id: text('id').primaryKey(),
	conceptId: text('concept_id').notNull().references(() => concepts.id),
	label: text('label').notNull(),
	embedding: vector('embedding', { dimensions: 768 })
});

// ── Hosted tier: API keys, preferences, webhooks ────────────────────────────
export const apiKeys = pgTable('api_keys', {
	id: text('id').primaryKey(),
	orgId: text('org_id').notNull().references(() => organizations.id),
	name: text('name').notNull(),
	tokenHash: text('token_hash').notNull(),
	tokenHint: text('token_hint').notNull().default(''),
	createdBy: text('created_by'),
	createdAt: timestamp('created_at').notNull().defaultNow(),
	lastUsedAt: timestamp('last_used_at')
});

export const userPreferences = pgTable('user_preferences', {
	userId: text('user_id').primaryKey(),
	prefs: jsonb('prefs').$type<Record<string, unknown>>().notNull().default({}),
	updatedAt: timestamp('updated_at').notNull().defaultNow()
});

export const webhooks = pgTable('webhooks', {
	id: text('id').primaryKey(),
	orgId: text('org_id').notNull().references(() => organizations.id),
	url: text('url').notNull(),
	event: text('event').notNull().default('*'),
	active: boolean('active').notNull().default(true),
	createdAt: timestamp('created_at').notNull().defaultNow()
});

// ── Billing (Stripe) ────────────────────────────────────────────────────────
export const billing = pgTable('billing', {
	orgId: text('org_id').primaryKey().references(() => organizations.id),
	stripeCustomerId: text('stripe_customer_id'),
	stripeSubscriptionId: text('stripe_subscription_id'),
	plan: text('plan').notNull().default('free'),
	status: text('status').notNull().default('inactive'),
	currentPeriodEnd: timestamp('current_period_end'),
	updatedAt: timestamp('updated_at').notNull().defaultNow()
});

// ── Eval: computed golden-set runs ──────────────────────────────────────────
export const evalRuns = pgTable('eval_runs', {
	id: text('id').primaryKey(),
	orgId: text('org_id').notNull().references(() => organizations.id),
	faithfulness: real('faithfulness').notNull().default(0),
	citationAccuracy: real('citation_accuracy').notNull().default(0),
	hallucinationRate: real('hallucination_rate').notNull().default(0),
	noveltyPrecision: real('novelty_precision').notNull().default(0),
	recentTests: jsonb('recent_tests').$type<unknown[]>().notNull().default([]),
	createdAt: timestamp('created_at').notNull().defaultNow()
});
