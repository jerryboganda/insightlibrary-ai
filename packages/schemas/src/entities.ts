import { z } from 'zod';

/**
 * Core domain entities, derived from the prototype's lib/mock-data.ts — the
 * de-facto specification. These are the wire types (what the API returns) and
 * the source of truth the Drizzle schema mirrors.
 */

// ── Tenancy & identity ────────────────────────────────────────────────────
export const roleSchema = z.enum(['owner', 'admin', 'editor', 'viewer']);
export type Role = z.infer<typeof roleSchema>;

export const organizationSchema = z.object({
	id: z.string(),
	name: z.string(),
	slug: z.string(),
	tenantId: z.string()
});
export type Organization = z.infer<typeof organizationSchema>;

export const userSchema = z.object({
	id: z.string(),
	name: z.string(),
	email: z.email(),
	role: roleSchema,
	initials: z.string(),
	lastActive: z.string()
});
export type User = z.infer<typeof userSchema>;

// ── Library ───────────────────────────────────────────────────────────────
export const folderSchema = z.object({
	id: z.string(),
	name: z.string(),
	docs: z.number().int().nonnegative(),
	topics: z.number().int().nonnegative(),
	/** 0-100 content health score */
	health: z.number().min(0).max(100),
	lastUpdated: z.string()
});
export type Folder = z.infer<typeof folderSchema>;

export const documentStatusSchema = z.enum([
	'indexed',
	'processing',
	'needs_review',
	'failed'
]);
export type DocumentStatus = z.infer<typeof documentStatusSchema>;

export const documentSchema = z.object({
	id: z.string(),
	folderId: z.string(),
	title: z.string(),
	status: documentStatusSchema,
	/** Human-readable status straight from the pipeline, e.g. "Processing (OCR)" */
	statusLabel: z.string(),
	type: z.enum(['pdf', 'docx', 'epub']),
	pages: z.number().int().nonnegative(),
	topics: z.number().int().nonnegative(),
	uploadedAt: z.string()
});
export type Document = z.infer<typeof documentSchema>;

export const sourceSchema = z.object({
	id: z.string(),
	name: z.string(),
	author: z.string(),
	type: z.string(),
	/** 1 = highest priority for conflict resolution */
	priority: z.number().int().min(1),
	date: z.string()
});
export type Source = z.infer<typeof sourceSchema>;

// ── SSOT / topics ───────────────────────────────────────────────────────────
export const claimSchema = z.object({
	id: z.string(),
	content: z.string(),
	/** Citation refs interleaved: [sourceId, locator, sourceId, locator, ...] */
	citations: z.array(z.string())
});
export type Claim = z.infer<typeof claimSchema>;

export const topicSectionSchema = z.object({
	id: z.string(),
	title: z.string(),
	/** lucide icon name, resolved to a component on the client */
	icon: z.string(),
	claims: z.array(claimSchema)
});
export type TopicSection = z.infer<typeof topicSectionSchema>;

export const topicSchema = z.object({
	id: z.string(),
	name: z.string(),
	aliases: z.array(z.string()),
	/** 0-100 completeness/health */
	health: z.number().min(0).max(100),
	updates: z.number().int().nonnegative(),
	folder: z.string(),
	lastUpdated: z.string(),
	sections: z.array(topicSectionSchema).optional()
});
export type Topic = z.infer<typeof topicSchema>;

export const coverageCellSchema = z.enum(['Strong', 'Medium', 'Weak', 'None']);
export type CoverageCell = z.infer<typeof coverageCellSchema>;

export const coverageRowSchema = z.object({
	aspect: z.string(),
	bA: coverageCellSchema,
	bB: coverageCellSchema,
	bC: coverageCellSchema,
	bD: coverageCellSchema,
	status: z.string()
});
export type CoverageRow = z.infer<typeof coverageRowSchema>;

export const deltaTypeSchema = z.enum([
	'duplicate',
	'citation',
	'expand',
	'new',
	'conflict'
]);
export const deltaEntrySchema = z.object({
	id: z.string(),
	type: deltaTypeSchema,
	text: z.string(),
	details: z.string()
});
export type DeltaEntry = z.infer<typeof deltaEntrySchema>;

// ── Study ─────────────────────────────────────────────────────────────────
export const flashcardStateSchema = z.enum(['new', 'learning', 'review', 'relearning']);
export type FlashcardState = z.infer<typeof flashcardStateSchema>;

export const flashcardSchema = z.object({
	id: z.string(),
	topicId: z.string(),
	topic: z.string(),
	front: z.string(),
	back: z.string(),
	// Optional spaced-repetition fields (present once a card has been scheduled).
	sourceClaimId: z.string().nullish(),
	dueAt: z.string().nullish(),
	intervalDays: z.number().optional(),
	easeFactor: z.number().optional(),
	stability: z.number().optional(),
	difficulty: z.number().optional(),
	repetitions: z.number().int().optional(),
	lapses: z.number().int().optional(),
	lastReviewedAt: z.string().nullish(),
	state: flashcardStateSchema.optional()
});
export type Flashcard = z.infer<typeof flashcardSchema>;

/** A grade submitted when reviewing a card (Again/Hard/Good/Easy → 1..4). */
export const flashcardGradeSchema = z.object({
	grade: z.number().int().min(1).max(4)
});
export type FlashcardGrade = z.infer<typeof flashcardGradeSchema>;

// ── Exam engine: MCQs / vignettes ───────────────────────────────────────────
export const mcqOptionSchema = z.object({ id: z.string(), text: z.string() });
export const mcqSchema = z.object({
	id: z.string(),
	topicId: z.string(),
	claimId: z.string().nullish(),
	stem: z.string(),
	options: z.array(mcqOptionSchema),
	// Omitted from list payloads for non-editors (B13) — revealed via POST /api/mcqs/[id]/attempt.
	correctOptionId: z.string().optional(),
	explanation: z.string().optional(),
	difficulty: z.enum(['easy', 'medium', 'hard']),
	examTags: z.array(z.string()),
	status: z.enum(['draft', 'published']).default('draft')
});
export type Mcq = z.infer<typeof mcqSchema>;

// ── Knowledge graph ─────────────────────────────────────────────────────────
export const graphNodeSchema = z.object({
	id: z.string(),
	group: z.string(),
	size: z.number().positive(),
	// Optional semantic fields (populated by the correlation engine).
	kind: z.string().optional(),
	label: z.string().optional(),
	canonicalConceptId: z.string().nullish(),
	description: z.string().optional()
});
export type GraphNode = z.infer<typeof graphNodeSchema>;

export const graphEdgeSchema = z.object({
	source: z.string(),
	target: z.string(),
	label: z.string(),
	rel: z.string().optional(),
	weight: z.number().optional(),
	sourceClaimId: z.string().nullish()
});
export type GraphEdge = z.infer<typeof graphEdgeSchema>;

export const graphSchema = z.object({
	nodes: z.array(graphNodeSchema),
	edges: z.array(graphEdgeSchema)
});
export type Graph = z.infer<typeof graphSchema>;

// ── Review queue ────────────────────────────────────────────────────────────
export const reviewItemSchema = z.object({
	id: z.string(),
	topic: z.string(),
	type: z.enum(['conflict', 'new']),
	status: z.enum(['pending', 'accepted', 'rejected']),
	originalClaim: z.string().nullable(),
	newClaim: z.string(),
	sourceA: z.string().nullable(),
	sourceB: z.string(),
	confidence: z.string(),
	notes: z.string()
});
export type ReviewItem = z.infer<typeof reviewItemSchema>;

// ── Admin: usage / evaluation / processing / audit / ontology ───────────────
export const usageEventSchema = z.object({
	name: z.string(),
	count: z.number().int().nonnegative(),
	cost: z.number().nonnegative()
});
export const usageMetricsSchema = z.object({
	monthlyBudget: z.number(),
	currentSpend: z.number(),
	queries: z.number().int(),
	costPerQuery: z.number(),
	activeUsers: z.number().int(),
	storageGB: z.number(),
	events: z.array(usageEventSchema),
	// ── Additive metering extensions (GET /api/usage; absent from the seed repo) ──
	/** Aggregation window this payload covers. */
	period: z.enum(['month', 'all']).optional(),
	/** Org budget configuration + live month spend (org_settings-backed). */
	budget: z
		.object({
			monthlyLimitUsd: z.number(),
			softThresholdPct: z.number(),
			spendThisMonthUsd: z.number(),
			enforced: z.boolean()
		})
		.optional(),
	/** Per provider+model rollup of metered AI calls. */
	byProvider: z
		.array(
			z.object({
				provider: z.string(),
				model: z.string(),
				calls: z.number().int(),
				tokensIn: z.number(),
				tokensOut: z.number(),
				costUsd: z.number()
			})
		)
		.optional(),
	/** Earliest metered event timestamp, null when nothing metered yet. */
	meteredSince: z.string().nullable().optional()
});
export type UsageMetrics = z.infer<typeof usageMetricsSchema>;

export const evalTestSchema = z.object({
	query: z.string(),
	mode: z.string(),
	status: z.enum(['Pass', 'Warning', 'Fail']),
	faithfulness: z.number()
});
export const evaluationMetricsSchema = z.object({
	faithfulness: z.number(),
	citationAccuracy: z.number(),
	hallucinationRate: z.number(),
	noveltyPrecision: z.number(),
	recentTests: z.array(evalTestSchema)
});
export type EvaluationMetrics = z.infer<typeof evaluationMetricsSchema>;

export const processingStageSchema = z.enum([
	'queued',
	'extract',
	'parse',
	'chunk',
	'contextualize',
	'embed',
	'index',
	'claims',
	'correlate',
	'graph',
	'refine',
	'done',
	'failed'
]);
export type ProcessingStage = z.infer<typeof processingStageSchema>;

export const processingJobSchema = z.object({
	id: z.string(),
	documentId: z.string(),
	documentTitle: z.string(),
	stage: processingStageSchema,
	progress: z.number().min(0).max(100),
	startedAt: z.string(),
	message: z.string()
});
export type ProcessingJob = z.infer<typeof processingJobSchema>;

export const auditLogSchema = z.object({
	id: z.string(),
	actor: z.string(),
	action: z.string(),
	target: z.string(),
	timestamp: z.string(),
	severity: z.enum(['info', 'warning', 'critical'])
});
export type AuditLog = z.infer<typeof auditLogSchema>;

export const ontologySchema = z.object({
	id: z.string(),
	name: z.string(),
	entities: z.number().int(),
	relations: z.number().int(),
	status: z.enum(['active', 'draft']),
	lastUpdated: z.string()
});
export type Ontology = z.infer<typeof ontologySchema>;

// ── Notifications ───────────────────────────────────────────────────────────
export const notificationSchema = z.object({
	id: z.string(),
	type: z.enum(['ssot_merge', 'conflict', 'novelty', 'alert']),
	title: z.string(),
	description: z.string(),
	time: z.string(),
	read: z.boolean(),
	action: z.string().nullable()
});
export type Notification = z.infer<typeof notificationSchema>;

// ── Refinery: first-class claims, provenance, versions ──────────────────────
export const claimTypeSchema = z.enum([
	'fact',
	'definition',
	'mechanism',
	'classification',
	'symptom',
	'sign',
	'lab',
	'diagnosis',
	'treatment',
	'pharmacology',
	'complication',
	'differential',
	'exam_pearl',
	'contraindication',
	'table_fact',
	'figure_fact'
]);
export type ClaimType = z.infer<typeof claimTypeSchema>;

export const claimStatusSchema = z.enum(['active', 'draft', 'superseded', 'conflicted', 'retired']);
export type ClaimStatus = z.infer<typeof claimStatusSchema>;

export const claimSourceSchema = z.object({
	id: z.string(),
	claimId: z.string(),
	sourceId: z.string().nullish(),
	sourceRef: z.string().nullish(),
	locator: z.string().nullish(),
	documentId: z.string().nullish(),
	chunkId: z.string().nullish(),
	blockId: z.string().nullish(),
	stance: z.enum(['supports', 'refutes', 'context']).default('supports')
});
export type ClaimSource = z.infer<typeof claimSourceSchema>;

/** First-class normalized claim (distinct from the JSONB-embedded `Claim`). */
export const normalizedClaimSchema = z.object({
	id: z.string(),
	topicId: z.string().nullish(),
	sectionId: z.string().nullish(),
	claimType: claimTypeSchema,
	claimText: z.string(),
	ontologyIds: z.array(z.string()),
	systemTags: z.array(z.string()),
	examTags: z.array(z.string()),
	confidence: z.number(),
	status: claimStatusSchema,
	sources: z.array(claimSourceSchema).default([])
});
export type NormalizedClaim = z.infer<typeof normalizedClaimSchema>;

export const topicVersionSchema = z.object({
	id: z.string(),
	topicId: z.string(),
	version: z.number().int(),
	pageMd: z.string(),
	changelog: z.array(z.object({ type: z.string(), text: z.string(), details: z.string() })),
	faithfulness: z.number().nullish(),
	createdBy: z.string().nullish(),
	createdAt: z.string()
});
export type TopicVersion = z.infer<typeof topicVersionSchema>;
