import { and, desc, eq, ilike, sql } from 'drizzle-orm';
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
import { rerankResults } from '../ai/rerank';
import { expandQuery } from '../ai/expansion';
import { computeCoverage } from './coverage';
import { getOrgSettings } from '../org-settings';
import { normalizeAppRole } from '../auth-config';

/**
 * Directory row returned by GET /api/users — the wire `User` enriched with the
 * real better-auth account state. `hasLogin=false` marks rows without a login
 * account (seed/local records); `emailVerified`/`createdAt` are null for them.
 */
export interface DirectoryUser extends User {
	status: 'active' | 'suspended';
	emailVerified: boolean | null;
	createdAt: string | null;
	hasLogin: boolean;
}

function initialsFor(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	const initials = parts
		.slice(0, 2)
		.map((p) => p[0]!.toUpperCase())
		.join('');
	return initials || 'U';
}

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

	/** Idempotently create the FTS tsvector column + GIN indexes (once per process). */
	private async ensureFts(): Promise<void> {
		if (this.ftsReady) return;
		await this.db.execute(
			sql`ALTER TABLE chunks ADD COLUMN IF NOT EXISTS content_fts tsvector
			    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED`
		);
		await this.db.execute(
			sql`CREATE INDEX IF NOT EXISTS chunks_content_fts_idx ON chunks USING gin(content_fts)`
		);
		// Context-weighted FTS: the contextual-retrieval prefix (chunks.context) is
		// weighted 'A' above the body 'B'. An expression index (additive, no rewrite
		// of the generated column) keeps this safe on the live table.
		await this.db.execute(
			sql`CREATE INDEX IF NOT EXISTS chunks_weighted_fts_idx ON chunks USING gin (
			    (setweight(to_tsvector('english', coalesce(context, '')), 'A') ||
			     setweight(to_tsvector('english', content), 'B')))`
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
		// JSONB remains the authoritative SSOT the UI reads.
		await this.db
			.update(schema.topics)
			.set({ sections, updatedAt: new Date() })
			.where(eq(schema.topics.id, topicId));

		// Dual-write into the normalized claims tables (best-effort; never blocks
		// the primary JSONB write the app depends on).
		await this.writeNormalizedClaim(topicId, input.sectionId, claim).catch((e) => {
			console.error('[addClaim] normalized dual-write failed:', e instanceof Error ? e.message : e);
		});
		return claim;
	}

	/** Insert one JSONB claim as a first-class claims row + its claim_sources. */
	private async writeNormalizedClaim(topicId: string, sectionId: string, claim: Claim): Promise<void> {
		const claimRowId = `nc_${topicId}_${sectionId}_${claim.id}`;
		const embedding = await embedText(claim.content).catch(() => null);
		await this.db
			.insert(schema.claims)
			.values({
				id: claimRowId,
				orgId: this.orgId,
				topicId,
				sectionId,
				jsonbClaimId: claim.id,
				claimType: 'fact',
				claimText: claim.content,
				normalizedMeaning: embedding,
				status: 'active'
			})
			.onConflictDoNothing();
		// citations are interleaved [sourceRef, locator, sourceRef, locator, ...]
		const rows: (typeof schema.claimSources.$inferInsert)[] = [];
		for (let i = 0; i < claim.citations.length; i += 2) {
			const sourceRef = claim.citations[i];
			const locator = claim.citations[i + 1] ?? null;
			if (!sourceRef) continue;
			rows.push({ id: `cs_${claimRowId}_${i}`, claimId: claimRowId, sourceRef, locator, stance: 'supports' });
		}
		if (rows.length) await this.db.insert(schema.claimSources).values(rows).onConflictDoNothing();
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
		// Admin-tunable retrieval constants (org settings; env/hardcoded defaults).
		const cfg = await getOrgSettings(this.orgId).catch(() => null);
		const K = cfg?.searchRrfK ?? 60;
		const armLimit = cfg?.searchCandidates ?? 30;
		const topK = cfg?.searchTopK ?? 20;
		const snippetLen = cfg?.searchSnippetLength ?? 240;
		const qvec = await embedText(q);
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
			       row_number() OVER (ORDER BY ts_rank(
			         setweight(to_tsvector('english', coalesce(c.context, '')), 'A') ||
			         setweight(to_tsvector('english', c.content), 'B'),
			         plainto_tsquery('english', ${q})) DESC) AS rank
			FROM chunks c JOIN documents d ON d.id = c.document_id
			WHERE (setweight(to_tsvector('english', coalesce(c.context, '')), 'A') ||
			       setweight(to_tsvector('english', c.content), 'B')) @@ plainto_tsquery('english', ${q})
			LIMIT ${armLimit}
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
				LIMIT ${armLimit}
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

		// Optional rerank hop over the top fused candidates (org setting: rerank;
		// off by default → identical behavior). Blends the rerank score onto RRF.
		let entries = [...fused.entries()].sort((a, b) => b[1].score - a[1].score);
		const topN = entries.slice(0, armLimit);
		const reranked = await rerankResults(q, topN.map(([id, v]) => ({ id, text: v.content })), this.orgId).catch(
			() => new Map<string, number>()
		);
		if (reranked.size) {
			for (const [id, v] of topN) {
				const rs = reranked.get(id);
				if (rs !== undefined) v.score += rs;
			}
			topN.sort((a, b) => b[1].score - a[1].score);
			entries = [...topN, ...entries.slice(armLimit)];
		}

		const results: SearchResult[] = entries.slice(0, topK).map(([id, v]) => ({
			kind: 'chunk' as const,
			id,
			title: v.title,
			snippet: v.content.slice(0, snippetLen),
			href: `/folders/${v.folderId}/${v.documentId}`,
			score: v.score
		}));

		// Entity matches (topics/folders) surfaced alongside chunk hits.
		const like = `%${q}%`;
		const topicMatches = await this.db
			.select()
			.from(schema.topics)
			.where(and(eq(schema.topics.orgId, this.orgId), ilike(schema.topics.name, like)));
		const seenTopics = new Set<string>();
		for (const t of topicMatches) {
			seenTopics.add(t.id);
			results.unshift({
				kind: 'topic',
				id: t.id,
				title: t.name,
				snippet: (t.aliases as string[]).join(', ') || 'Canonical SSOT topic',
				href: `/topics/${t.id}`,
				score: 1
			});
		}

		// Ontology-aware recall audit: for entity-like queries, also surface topics
		// matching the query's ontology aliases (e.g. "Addison" → "primary adrenal
		// insufficiency"). Guarded to short queries to bound cost.
		if (q.split(/\s+/).length <= 5) {
			const aliases = await expandQuery(q).catch(() => [] as string[]);
			for (const alias of aliases) {
				if (alias.toLowerCase() === q.toLowerCase()) continue;
				const m = await this.db
					.select()
					.from(schema.topics)
					.where(and(eq(schema.topics.orgId, this.orgId), ilike(schema.topics.name, `%${alias}%`)));
				for (const tt of m) {
					if (seenTopics.has(tt.id)) continue;
					seenTopics.add(tt.id);
					results.unshift({
						kind: 'topic',
						id: tt.id,
						title: tt.name,
						snippet: `Matched via alias "${alias}"`,
						href: `/topics/${tt.id}`,
						score: 0.95
					});
				}
			}
		}

		return { results, mode };
	}

	async listFlashcards(topicId?: string): Promise<Flashcard[]> {
		const rows = topicId
			? await this.db.select().from(schema.flashcards).where(eq(schema.flashcards.topicId, topicId))
			: await this.db.select().from(schema.flashcards);
		return rows.map((r) => ({
			id: r.id,
			topicId: r.topicId,
			topic: r.topic,
			front: r.front,
			back: r.back,
			sourceClaimId: r.sourceClaimId ?? null,
			dueAt: r.dueAt?.toISOString() ?? null,
			intervalDays: r.intervalDays,
			easeFactor: r.easeFactor,
			repetitions: r.repetitions,
			lapses: r.lapses,
			lastReviewedAt: r.lastReviewedAt?.toISOString() ?? null,
			state: r.state as Flashcard['state']
		}));
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
		const [r] = await this.db
			.select()
			.from(schema.evalRuns)
			.where(eq(schema.evalRuns.orgId, this.orgId))
			.orderBy(desc(schema.evalRuns.createdAt))
			.limit(1);
		if (!r) return seedEvaluation;
		return {
			faithfulness: r.faithfulness,
			citationAccuracy: r.citationAccuracy,
			hallucinationRate: r.hallucinationRate,
			noveltyPrecision: r.noveltyPrecision,
			recentTests: r.recentTests as EvaluationMetrics['recentTests']
		};
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
	/**
	 * Real user directory (B4): app `users` rows enriched with their better-auth
	 * account (matched by email — signup hooks keep ids aligned for new users),
	 * plus any better-auth signups that predate the mirroring hooks. Nothing is
	 * fabricated: status/verified/created/last-active are actual column values,
	 * and rows without a login account say so via hasLogin=false.
	 */
	async listUsers(): Promise<DirectoryUser[]> {
		const appRows = await this.db
			.select()
			.from(schema.users)
			.where(eq(schema.users.orgId, this.orgId));

		type AuthRow = {
			id: string;
			name: string;
			email: string;
			emailVerified: boolean;
			createdAt: Date;
			role: string | null;
			banned: boolean | null;
			lastSeenAt: Date | string | null;
		};
		let authRows: AuthRow[] = [];
		try {
			authRows = await this.db
				.select({
					id: schema.user.id,
					name: schema.user.name,
					email: schema.user.email,
					emailVerified: schema.user.emailVerified,
					createdAt: schema.user.createdAt,
					role: schema.user.role,
					banned: schema.user.banned,
					// Most recent session touch — cheap via session_userId_idx.
					lastSeenAt: sql<
						Date | string | null
					>`(select max(s.updated_at) from session s where s.user_id = ${schema.user.id})`
				})
				.from(schema.user);
		} catch {
			// better-auth tables not migrated on this deployment — app rows only.
		}

		const byEmail = new Map(authRows.map((a) => [a.email.toLowerCase(), a]));
		const merged = new Set<string>();
		const items: DirectoryUser[] = appRows.map((r) => {
			const a = byEmail.get(r.email.toLowerCase());
			if (a) merged.add(a.email.toLowerCase());
			const lastSeen = a?.lastSeenAt ? new Date(a.lastSeenAt) : null;
			return {
				id: r.id,
				name: r.name,
				email: r.email,
				role: r.role as User['role'],
				initials: r.initials || initialsFor(r.name),
				lastActive: (lastSeen ?? r.lastActiveAt).toISOString(),
				status: a?.banned || r.status === 'suspended' ? 'suspended' : 'active',
				emailVerified: a ? a.emailVerified : null,
				createdAt: a ? a.createdAt.toISOString() : null,
				hasLogin: Boolean(a)
			};
		});
		// Signups that predate the auth-config mirroring hooks (or whose mirror
		// insert failed): surface them too — they are the *real* accounts.
		for (const a of authRows) {
			if (merged.has(a.email.toLowerCase())) continue;
			items.push({
				id: a.id,
				name: a.name || a.email,
				email: a.email,
				role: normalizeAppRole(a.role),
				initials: initialsFor(a.name || a.email),
				lastActive: a.lastSeenAt ? new Date(a.lastSeenAt).toISOString() : '',
				status: a.banned ? 'suspended' : 'active',
				emailVerified: a.emailVerified,
				createdAt: a.createdAt.toISOString(),
				hasLogin: true
			});
		}
		return items.sort((x, y) => x.name.localeCompare(y.name));
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
