import { computeCoverage } from './coverage';
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

/**
 * The data-access contract every backend implementation satisfies. Two impls
 * exist: an in-memory one seeded from the prototype dataset (default; runs with
 * zero external services) and a Postgres/Drizzle one (activated by DATABASE_URL).
 * Screens and API routes depend only on this interface.
 */
export interface Repository {
	readonly kind: 'memory' | 'postgres';

	// Library
	listFolders(): Promise<Folder[]>;
	getFolder(id: string): Promise<Folder | null>;
	createFolder(input: { name: string }): Promise<Folder>;
	listDocuments(folderId?: string): Promise<Document[]>;
	getDocument(id: string): Promise<Document | null>;
	createDocument(input: {
		folderId: string;
		title: string;
		type: Document['type'];
		pages: number;
		storageKey?: string;
	}): Promise<Document>;
	listSources(): Promise<Source[]>;

	// Topics / SSOT
	listTopics(): Promise<Topic[]>;
	getTopic(id: string): Promise<Topic | null>;
	getCoverage(topicId: string): Promise<CoverageRow[]>;
	getDelta(topicId: string): Promise<DeltaEntry[]>;
	addClaim(topicId: string, input: NewClaim): Promise<Claim | null>;

	// Hybrid search (FTS + vector RRF on Postgres; substring in memory)
	search(query: string): Promise<{ results: SearchResult[]; mode: 'hybrid' | 'text' }>;

	// Study
	listFlashcards(topicId?: string): Promise<Flashcard[]>;

	// Graph
	getGraph(): Promise<Graph>;

	// Review
	listReview(): Promise<ReviewItem[]>;
	resolveReview(id: string, decision: 'accepted' | 'rejected'): Promise<ReviewItem | null>;

	// Admin
	getUsage(): Promise<UsageMetrics>;
	getEvaluation(): Promise<EvaluationMetrics>;
	listProcessing(): Promise<ProcessingJob[]>;
	listAudit(): Promise<AuditLog[]>;
	listOntologies(): Promise<Ontology[]>;
	listUsers(): Promise<User[]>;

	// Notifications
	listNotifications(): Promise<Notification[]>;
	markAllNotificationsRead(): Promise<void>;
}

function clone<T>(v: T): T {
	return structuredClone(v);
}

export class InMemoryRepository implements Repository {
	readonly kind = 'memory' as const;

	constructor(
		private state: {
			folders: Folder[];
			documents: Document[];
			sources: Source[];
			topics: Topic[];
			coverage: CoverageRow[];
			delta: DeltaEntry[];
			flashcards: Flashcard[];
			graph: Graph;
			review: ReviewItem[];
			usage: UsageMetrics;
			evaluation: EvaluationMetrics;
			processing: ProcessingJob[];
			audit: AuditLog[];
			ontologies: Ontology[];
			users: User[];
			notifications: Notification[];
		}
	) {}

	async listFolders() {
		return clone(this.state.folders);
	}
	async getFolder(id: string) {
		return clone(this.state.folders.find((f) => f.id === id) ?? null);
	}
	async createFolder(input: { name: string }) {
		const folder: Folder = {
			id: `f_${this.state.folders.length + 1}_${input.name.toLowerCase().replace(/\s+/g, '-')}`,
			name: input.name,
			docs: 0,
			topics: 0,
			health: 100,
			lastUpdated: 'just now'
		};
		this.state.folders.push(folder);
		return clone(folder);
	}
	async listDocuments(folderId?: string) {
		const docs = folderId
			? this.state.documents.filter((d) => d.folderId === folderId)
			: this.state.documents;
		return clone(docs);
	}
	async getDocument(id: string) {
		return clone(this.state.documents.find((d) => d.id === id) ?? null);
	}
	async createDocument(input: {
		folderId: string;
		title: string;
		type: Document['type'];
		pages: number;
		storageKey?: string;
	}) {
		const doc: Document = {
			id: `doc_${this.state.documents.length + 1}`,
			folderId: input.folderId,
			title: input.title,
			status: 'processing',
			statusLabel: 'Processing (queued)',
			type: input.type,
			pages: input.pages,
			topics: 0,
			uploadedAt: new Date().toISOString().slice(0, 10)
		};
		this.state.documents.push(doc);
		const folder = this.state.folders.find((f) => f.id === input.folderId);
		if (folder) folder.docs += 1;
		return clone(doc);
	}
	async listSources() {
		return clone(this.state.sources);
	}

	async listTopics(): Promise<Topic[]> {
		// Strip heavy sections from list view; detail endpoint returns them.
		return clone(this.state.topics).map(({ sections: _sections, ...rest }) => rest);
	}
	async getTopic(id: string) {
		return clone(this.state.topics.find((t) => t.id === id) ?? null);
	}
	async getCoverage(topicId: string) {
		// Computed from the topic's real claim citations (see coverage.ts).
		const topic = this.state.topics.find((t) => t.id === topicId) ?? null;
		return computeCoverage(clone(topic));
	}
	async getDelta() {
		return clone(this.state.delta);
	}
	async addClaim(topicId: string, input: NewClaim) {
		const topic = this.state.topics.find((t) => t.id === topicId);
		const section = topic?.sections?.find((s) => s.id === input.sectionId);
		if (!section) return null;
		const claim: Claim = {
			id: `c_${topicId}_${Date.now()}`,
			content: input.content,
			citations: input.citations
		};
		section.claims.push(claim);
		return clone(claim);
	}

	async search(query: string) {
		const q = query.trim().toLowerCase();
		if (!q) return { results: [], mode: 'text' as const };
		const results: SearchResult[] = [];

		// Topics: match name/aliases, and surface matching claims as chunk hits.
		for (const t of this.state.topics) {
			if (t.name.toLowerCase().includes(q) || t.aliases.some((a) => a.toLowerCase().includes(q))) {
				results.push({
					kind: 'topic',
					id: t.id,
					title: t.name,
					snippet: t.aliases.join(', ') || 'Canonical SSOT topic',
					href: `/topics/${t.id}`,
					score: 1
				});
			}
			for (const section of t.sections ?? []) {
				for (const claim of section.claims) {
					if (claim.content.toLowerCase().includes(q)) {
						results.push({
							kind: 'chunk',
							id: claim.id,
							title: `${t.name} · ${section.title}`,
							snippet: claim.content,
							href: `/topics/${t.id}`,
							score: 0.9
						});
					}
				}
			}
		}
		// Documents & folders by title/name.
		for (const d of this.state.documents) {
			if (d.title.toLowerCase().includes(q)) {
				results.push({
					kind: 'document',
					id: d.id,
					title: d.title,
					snippet: `${d.type.toUpperCase()} · ${d.pages} pages · ${d.statusLabel}`,
					href: `/folders/${d.folderId}/${d.id}`,
					score: 0.7
				});
			}
		}
		for (const f of this.state.folders) {
			if (f.name.toLowerCase().includes(q)) {
				results.push({
					kind: 'folder',
					id: f.id,
					title: f.name,
					snippet: `${f.docs} documents · ${f.topics} topics`,
					href: `/folders/${f.id}`,
					score: 0.6
				});
			}
		}
		return { results, mode: 'text' as const };
	}

	async listFlashcards(topicId?: string) {
		const cards = topicId
			? this.state.flashcards.filter((c) => c.topicId === topicId)
			: this.state.flashcards;
		return clone(cards);
	}

	async getGraph() {
		return clone(this.state.graph);
	}

	async listReview() {
		return clone(this.state.review);
	}
	async resolveReview(id: string, decision: 'accepted' | 'rejected') {
		const item = this.state.review.find((r) => r.id === id);
		if (!item) return null;
		item.status = decision;
		return clone(item);
	}

	async getUsage() {
		return clone(this.state.usage);
	}
	async getEvaluation() {
		return clone(this.state.evaluation);
	}
	async listProcessing() {
		return clone(this.state.processing);
	}
	async listAudit() {
		return clone(this.state.audit);
	}
	async listOntologies() {
		return clone(this.state.ontologies);
	}
	async listUsers() {
		return clone(this.state.users);
	}

	async listNotifications() {
		return clone(this.state.notifications);
	}
	async markAllNotificationsRead() {
		this.state.notifications.forEach((n) => (n.read = true));
	}
}
