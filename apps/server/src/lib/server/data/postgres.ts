import { and, eq, ilike, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type {
	AuditLog,
	Claim,
	CoverageRow,
	DeltaEntry,
	Document,
	EvaluationMetrics,
	Flashcard,
	Folder,
	Graph,
	NewClaim,
	Notification,
	Ontology,
	ProcessingJob,
	ReviewItem,
	SearchResult,
	Source,
	Topic,
	UsageMetrics,
	User
} from '@insightlibrary/schemas';
import type { Repository } from './repository';
import * as schema from '../db/schema';
import { seedDelta, seedEvaluation } from './seed';
import { embedText } from '../ai/embeddings';
import { computeCoverage } from './coverage';

/**
 * Postgres/Drizzle implementation of the Repository contract. Activated when
 * DATABASE_URL is set. Row → wire-type mapping keeps API responses identical to
 * the in-memory path. Coverage/delta/evaluation are derived analytics in a real
 * system; here they reuse the seeded constants until the analytics jobs land.
 */
export class PostgresRepository implements Repository {
	readonly kind = 'postgres' as const;
	private db: NodePgDatabase<typeof schema>;

	private ftsReady = false;

	constructor(
		connectionString: string,
		private orgId = 'org_1'
	) {
		const pool = new pg.Pool({ connectionString });
		this.db = drizzle(pool, { schema });
	}

	/** Idempotently create the FTS tsvector column + GIN index (once per process). */
	private async ensureFts(): Promise<void> {
		if (this.ftsReady) return;
		await this.db.execute(
			sql`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS content_fts tsvector
			    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED`
		);
		await this.db.execute(
			sql`CREATE INDEX IF NOT EXISTS chunks_content_fts_idx ON chunks USING gin(content_fts)`
		);
		this.ftsReady = true;
	}

	private mapFolder(r: typeof schema.folders.$inferSelect, docCount: number, topicCount: number): Folder {
		return {
			id: r.id,
			name: r.name,
			docs: docCount,
			topics: topicCount,
			health: r.health,
			lastUpdated: r.updatedAt.toISOString()
		};
	}

	async listFolders(): Promise<Folder[]> {
		const rows = await this.db
			.select()
			.from(schema.folders)
			.where(eq(schema.folders.orgId, this.orgId));
		const docs = await this.db.select().from(schema.documents);
		return rows.map((r) =>
			this.mapFolder(r, docs.filter((d) => d.folderId === r.id).length, 0)
		);
	}
	async getFolder(id: string): Promise<Folder | null> {
		const [r] = await this.db.select().from(schema.folders).where(eq(schema.folders.id, id));
		if (!r) return null;
		const docs = await this.db.select().from(schema.documents).where(eq(schema.documents.folderId, id));
		return this.mapFolder(r, docs.length, 0);
	}
	async createFolder(input: { name: string }): Promise<Folder> {
		const id = `f_${Date.now()}`;
		const [r] = await this.db
			.insert(schema.folders)
			.values({ id, orgId: this.orgId, name: input.name, health: 100 })
			.returning();
		return this.mapFolder(r, 0, 0);
	}

	private mapDoc(r: typeof schema.documents.$inferSelect): Document {
		return {
			id: r.id,
			folderId: r.folderId,
			title: r.title,
			status: r.status as Document['status'],
			statusLabel: r.statusLabel,
			type: r.type as Document['type'],
			pages: r.pages,
			topics: 0,
			uploadedAt: r.uploadedAt.toISOString().slice(0, 10)
		};
	}
	async listDocuments(folderId?: string): Promise<Document[]> {
		const rows = folderId
			? await this.db.select().from(schema.documents).where(eq(schema.documents.folderId, folderId))
			: await this.db.select().from(schema.documents);
		return rows.map((r) => this.mapDoc(r));
	}
	async getDocument(id: string): Promise<Document | null> {
		const [r] = await this.db.select().from(schema.documents).where(eq(schema.documents.id, id));
		return r ? this.mapDoc(r) : null;
	}
	async createDocument(input: {
		folderId: string;
		title: string;
		type: Document['type'];
		pages: number;
		storageKey?: string;
	}): Promise<Document> {
		const id = `doc_${Date.now()}`;
		const [r] = await this.db
			.insert(schema.documents)
			.values({
				id,
				folderId: input.folderId,
				title: input.title,
				type: input.type,
				pages: input.pages,
				storageKey: input.storageKey ?? null,
				status: 'processing',
				statusLabel: 'Processing (queued)'
			})
			.returning();
		return this.mapDoc(r);
	}
	async listSources(): Promise<Source[]> {
		const rows = await this.db
			.select()
			.from(schema.sources)
			.where(eq(schema.sources.orgId, this.orgId));
		return rows.map((r) => ({
			id: r.id,
			name: r.name,
			author: r.author,
			type: r.type,
			priority: r.priority,
			date: r.date
		}));
	}

	async listTopics(): Promise<Topic[]> {
		const rows = await this.db.select().from(schema.topics).where(eq(schema.topics.orgId, this.orgId));
		return rows.map((r) => ({
			id: r.id,
			name: r.name,
			aliases: r.aliases,
			health: r.health,
			updates: r.updates,
			folder: r.folder,
			lastUpdated: r.updatedAt.toISOString()
		}));
	}
	async getTopic(id: string): Promise<Topic | null> {
		const [r] = await this.db.select().from(schema.topics).where(eq(schema.topics.id, id));
		if (!r) return null;
		return {
			id: r.id,
			name: r.name,
			aliases: r.aliases,
			health: r.health,
			updates: r.updates,
			folder: r.folder,
			lastUpdated: r.updatedAt.toISOString(),
			sections: r.sections as Topic['sections']
		};
	}
	async getCoverage(topicId: string): Promise<CoverageRow[]> {
		// Computed from the topic's real claim citations (see coverage.ts).
		return computeCoverage(await this.getTopic(topicId));
	}
	async getDelta(): Promise<DeltaEntry[]> {
		return seedDelta;
	}
	async addClaim(topicId: string, input: NewClaim): Promise<Claim | null> {
		const [row] = await this.db.select().from(schema.topics).where(eq(schema.topics.id, topicId));
		if (!row) return null;
		const sections = (row.sections as Topic['sections']) ?? [];
		const section = sections.find((s) => s.id === input.sectionId);
		if (!section) return null;
		const claim: Claim = {
			id: `c_${topicId}_${Date.now()}`,
			content: input.content,
			citations: input.citations
		};
		section.claims.push(claim);
		await this.db
			.update(schema.topics)
			.set({ sections, updatedAt: new Date() })
			.where(eq(schema.topics.id, topicId));
		return claim;
	}

	/**
	 * Hybrid search: Postgres FTS (tsvector/GIN, added by the seeder) + pgvector
	 * KNN, fused with Reciprocal Rank Fusion. Vector arm is skipped when no
	 * embedding key is configured, degrading gracefully to lexical-only.
	 */
	async search(query: string): Promise<{ results: SearchResult[]; mode: 'hybrid' | 'text' }> {
		const q = query.trim();
		if (!q) return { results: [], mode: 'text' };

		// Self-sufficient FTS: ensure the generated tsvector column + GIN index
		// exist even if the DB was created by db:push without running db:seed.
		await this.ensureFts();
		const qvec = await embedText(q);
		const K = 60;
		const fused = new Map<string, { score: number; documentId: string; content: string; title: string; folderId: string }>();

		// FTS arm.
		const fts = await this.db.execute<{
			id: string;
			documentId: string;
			content: string;
			title: string;
			folderId: string;
			rank: number;
		}>(sql`
			SELECT c.id, c.document_id AS "documentId", c.content, d.title, d.folder_id AS "folderId",
			       row_number() OVER (ORDER BY ts_rank(c.content_fts, plainto_tsquery('english', ${q})) DESC) AS rank
			FROM chunks c JOIN documents d ON d.id = c.document_id
			WHERE c.content_fts @@ plainto_tsquery('english', ${q})
			LIMIT 30
		`);
		for (const r of fts.rows) {
			const prev = fused.get(r.id);
			const score = 1 / (K + Number(r.rank));
			fused.set(r.id, {
				score: (prev?.score ?? 0) + score,
				documentId: r.documentId,
				content: r.content,
				title: r.title,
				folderId: r.folderId
			});
		}

		// Vector arm (only when we could embed the query).
		let mode: 'hybrid' | 'text' = 'text';
		if (qvec) {
			mode = 'hybrid';
			const literal = `[${qvec.join(',')}]`;
			const vec = await this.db.execute<{
				id: string;
				documentId: string;
				content: string;
				title: string;
				folderId: string;
				rank: number;
			}>(sql`
				SELECT c.id, c.document_id AS "documentId", c.content, d.title, d.folder_id AS "folderId",
				       row_number() OVER (ORDER BY c.embedding <=> ${literal}::vector) AS rank
				FROM chunks c JOIN documents d ON d.id = c.document_id
				WHERE c.embedding IS NOT NULL
				ORDER BY c.embedding <=> ${literal}::vector
				LIMIT 30
			`);
			for (const r of vec.rows) {
				const prev = fused.get(r.id);
				const score = 1 / (K + Number(r.rank));
				fused.set(r.id, {
					score: (prev?.score ?? 0) + score,
					documentId: r.documentId,
					content: r.content,
					title: r.title,
					folderId: r.folderId
				});
			}
		}

		const results: SearchResult[] = [...fused.entries()]
			.sort((a, b) => b[1].score - a[1].score)
			.slice(0, 20)
			.map(([id, v]) => ({
				kind: 'chunk' as const,
				id,
				title: v.title,
				snippet: v.content.slice(0, 240),
				href: `/folders/${v.folderId}/${v.documentId}`,
				score: v.score
			}));

		// Entity matches (topics/folders) surfaced alongside chunk hits.
		const like = `%${q}%`;
		const topicMatches = await this.db
			.select()
			.from(schema.topics)
			.where(and(eq(schema.topics.orgId, this.orgId), ilike(schema.topics.name, like)));
		for (const t of topicMatches) {
			results.unshift({
				kind: 'topic',
				id: t.id,
				title: t.name,
				snippet: (t.aliases as string[]).join(', ') || 'Canonical SSOT topic',
				href: `/topics/${t.id}`,
				score: 1
			});
		}

		return { results, mode };
	}

	async listFlashcards(topicId?: string): Promise<Flashcard[]> {
		const rows = topicId
			? await this.db.select().from(schema.flashcards).where(eq(schema.flashcards.topicId, topicId))
			: await this.db.select().from(schema.flashcards);
		return rows.map((r) => ({ id: r.id, topicId: r.topicId, topic: r.topic, front: r.front, back: r.back }));
	}

	async getGraph(): Promise<Graph> {
		const nodes = await this.db.select().from(schema.graphNodes).where(eq(schema.graphNodes.orgId, this.orgId));
		const edges = await this.db.select().from(schema.graphEdges).where(eq(schema.graphEdges.orgId, this.orgId));
		return {
			nodes: nodes.map((n) => ({ id: n.id, group: n.group, size: n.size })),
			edges: edges.map((e) => ({ source: e.source, target: e.target, label: e.label }))
		};
	}

	async listReview(): Promise<ReviewItem[]> {
		const rows = await this.db.select().from(schema.reviewItems).where(eq(schema.reviewItems.orgId, this.orgId));
		return rows.map((r) => ({
			id: r.id,
			topic: r.topic,
			type: r.type as ReviewItem['type'],
			status: r.status as ReviewItem['status'],
			originalClaim: r.originalClaim,
			newClaim: r.newClaim,
			sourceA: r.sourceA,
			sourceB: r.sourceB,
			confidence: r.confidence,
			notes: r.notes
		}));
	}
	async resolveReview(id: string, decision: 'accepted' | 'rejected'): Promise<ReviewItem | null> {
		const [r] = await this.db
			.update(schema.reviewItems)
			.set({ status: decision })
			.where(and(eq(schema.reviewItems.id, id), eq(schema.reviewItems.orgId, this.orgId)))
			.returning();
		if (!r) return null;
		return {
			id: r.id,
			topic: r.topic,
			type: r.type as ReviewItem['type'],
			status: r.status as ReviewItem['status'],
			originalClaim: r.originalClaim,
			newClaim: r.newClaim,
			sourceA: r.sourceA,
			sourceB: r.sourceB,
			confidence: r.confidence,
			notes: r.notes
		};
	}

	async getUsage(): Promise<UsageMetrics> {
		const [r] = await this.db.select().from(schema.usageMetrics).where(eq(schema.usageMetrics.orgId, this.orgId));
		if (!r) throw new Error('usage metrics not seeded');
		return {
			monthlyBudget: r.monthlyBudget,
			currentSpend: r.currentSpend,
			queries: r.queries,
			costPerQuery: r.costPerQuery,
			activeUsers: r.activeUsers,
			storageGB: r.storageGb,
			events: r.events as UsageMetrics['events']
		};
	}
	async getEvaluation(): Promise<EvaluationMetrics> {
		return seedEvaluation;
	}
	async listProcessing(): Promise<ProcessingJob[]> {
		const rows = await this.db.select().from(schema.processingJobs);
		return rows.map((r) => ({
			id: r.id,
			documentId: r.documentId,
			documentTitle: r.documentTitle,
			stage: r.stage as ProcessingJob['stage'],
			progress: r.progress,
			startedAt: r.startedAt.toISOString(),
			message: r.message
		}));
	}
	async listAudit(): Promise<AuditLog[]> {
		const rows = await this.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.orgId, this.orgId));
		return rows.map((r) => ({
			id: r.id,
			actor: r.actor,
			action: r.action,
			target: r.target,
			timestamp: r.timestamp.toISOString(),
			severity: r.severity as AuditLog['severity']
		}));
	}
	async listOntologies(): Promise<Ontology[]> {
		const rows = await this.db.select().from(schema.ontologies).where(eq(schema.ontologies.orgId, this.orgId));
		return rows.map((r) => ({
			id: r.id,
			name: r.name,
			entities: r.entities,
			relations: r.relations,
			status: r.status as Ontology['status'],
			lastUpdated: r.updatedAt.toISOString()
		}));
	}
	async listUsers(): Promise<User[]> {
		const rows = await this.db.select().from(schema.users).where(eq(schema.users.orgId, this.orgId));
		return rows.map((r) => ({
			id: r.id,
			name: r.name,
			email: r.email,
			role: r.role as User['role'],
			initials: r.initials,
			lastActive: r.lastActiveAt.toISOString()
		}));
	}

	async listNotifications(): Promise<Notification[]> {
		const rows = await this.db.select().from(schema.notifications).where(eq(schema.notifications.orgId, this.orgId));
		return rows.map((r) => ({
			id: r.id,
			type: r.type as Notification['type'],
			title: r.title,
			description: r.description,
			time: r.createdAt.toISOString(),
			read: r.read,
			action: r.action
		}));
	}
	async markAllNotificationsRead(): Promise<void> {
		await this.db
			.update(schema.notifications)
			.set({ read: true })
			.where(eq(schema.notifications.orgId, this.orgId));
	}
}
