import type {
	AiKeyInput,
	AiProviderSettingsInput,
	AiProvidersResponse,
	AuditLog,
	Claim,
	CopilotAttachment,
	CopilotMode,
	CoverageRow,
	DeltaEntry,
	Document,
	EvaluationMetrics,
	Flashcard,
	Folder,
	Graph,
	GraphStats,
	HealthResponse,
	Mcq,
	NewClaim,
	NormalizedClaim,
	Notification,
	Ontology,
	ProcessingJob,
	ProcessingStats,
	ProviderId,
	ReviewItem,
	SearchResponse,
	SessionResponse,
	SessionUser,
	Source,
	Topic,
	TopicSection,
	TopicVersion,
	UsageMetrics,
	User,
	WebhookEndpoint,
	WebhookTestResult
} from '@insightlibrary/schemas';

export interface ApiClientOptions {
	/** e.g. http://localhost:5174 in dev, https://api.insightlibrary.ai in prod */
	baseUrl: string;
	/** Bearer access-token supplier (Tauri: OS keyring). Web relies on cookies instead. */
	getToken?: () => Promise<string | null>;
	/**
	 * Refresh-token supplier for the 401→refresh→retry flow. Desktop returns the
	 * stored refresh token (sent in the body); web returns null and relies on the
	 * refresh cookie the server set at `/api/auth`.
	 */
	getRefreshToken?: () => Promise<string | null>;
	/**
	 * Persist rotated tokens after sign-in / sign-up / refresh. Desktop writes them
	 * to the OS keyring; web is a no-op (the server rotates cookies itself).
	 */
	onTokens?: (tokens: AuthTokens) => void | Promise<void>;
	/** Optional forwarded AI OAuth token (desktop ChatGPT subscription) for copilot. */
	getAiToken?: () => Promise<string | null>;
	fetchImpl?: typeof fetch;
}

/** Access + refresh JWT pair (matches the Rust auth endpoints' body). */
export interface AuthTokens {
	accessToken: string;
	refreshToken: string;
}

/** Successful sign-in / sign-up response: the session user, org, and token pair. */
export interface AuthSuccess extends AuthTokens {
	user: SessionUser;
	org: { id: string; name: string };
}

/** A device session row from `GET /api/auth/sessions`. `token` is the session id. */
export interface AuthSessionRow {
	id: string;
	token: string;
	userAgent?: string | null;
	ipAddress?: string | null;
	createdAt: string;
	expiresAt: string;
	lastSeenAt?: string | null;
	current: boolean;
}

/** System settings (super-admin scope) — grouped, restart-aware knobs. */
export interface SystemSettingsValues {
	queue: {
		concurrency: number;
		maxAttempts: number;
		claimIdleMs: number;
		perKindConcurrency: Record<string, number>;
	};
	rateLimit: { max: number; windowSecs: number; authMax: number };
	auth: { accessTtlSecs: number; refreshTtlSecs: number };
	pipeline: {
		parseMaxPages: number;
		parseMaxFileMb: number;
		lowConfThreshold: number;
		linkSimThreshold: number;
	};
	pricing: { models: unknown[]; providerFallback: Record<string, unknown> };
}
export interface SystemSettingsResponse {
	settings: SystemSettingsValues;
	defaults: SystemSettingsValues;
	restartRequired: {
		inferenceDenseModel: string;
		inferenceDenseDim: number;
		inferenceSparseModel: string;
		inferenceRerankModel: string;
		parserSvcUrl: string;
		inferenceSvcUrl: string;
	};
}
/** A tenant/org summary for the super-admin console. */
export interface AdminOrgSummary {
	id: string;
	kind: string;
	name: string;
	plan: string;
	suspended: boolean;
	createdAt: string;
}
/** A plan tier in the catalog. */
export interface AdminPlan {
	id: string;
	name: string;
	seats: number;
	documentCap: number;
	aiBudgetUsd: number;
	stripePriceId: string | null;
	features: unknown;
	active: boolean;
}

export class ApiError extends Error {
	constructor(
		public readonly status: number,
		public readonly body: string
	) {
		super(`API ${status}: ${body.slice(0, 200)}`);
	}
}

type ListEnvelope<T> = { items: T[]; total: number };

/** Effective org-level configuration values (env defaults overlaid with stored overrides). */
export interface OrgSettingsValues {
	strictCitationDefault: boolean;
	autoSsotTopics: boolean;
	requireReview: boolean;
	autoMergeConfidence: number;
	dedupCosine: number;
	dedupUseNli: boolean;
	conflictSubjectCosine: number;
	conflictEnabled: boolean;
	maxCorrelateClaims: number;
	parseMode: 'heuristic' | 'document-ai' | 'external';
	parseAiMaxPages: number;
	claimsMaxChunks: number;
	contextualMaxChunks: number;
	ontologyLinkMaxDistance: number;
	rerank: 'off' | 'llm' | 'cohere' | 'jina';
	searchRrfK: number;
	searchCandidates: number;
	searchTopK: number;
	searchSnippetLength: number;
	copilotPromptOverrides: Record<string, string>;
	sourcePriorityOrder: string[];
	/** SM-2 / FSRS study-scheduler tuning (nested; patch the whole object). */
	study: {
		scheduler: string;
		sm2: {
			initialEase: number;
			minEase: number;
			firstIntervalDays: number;
			secondIntervalDays: number;
		};
		fsrs: { requestRetention: number; maximumInterval: number };
	};
	/** LLM task routing / models / vendor config (also managed via /api/ai/providers). */
	ai: {
		taskRouting: Record<string, string>;
		fallbackOrder: string[];
		models: Record<string, string>;
		baseUrls: Record<string, string>;
		rerankModels: Record<string, string>;
		parseVendor: string;
	};
	/** Monthly AI spend hard limit in USD; 0 = unlimited (no enforcement). */
	budgetMonthlyLimitUsd: number;
	/** Soft-alert threshold as a % of the hard limit (default 80). */
	budgetSoftThresholdPct: number;
}

/** GET/PUT /api/org/settings response. */
export interface OrgSettingsResponse {
	name: string | null;
	logo: string | null;
	settings: OrgSettingsValues;
	defaults: OrgSettingsValues;
	overridden: string[];
	copilotPromptDefaults: Record<string, string>;
	updatedAt: string | null;
}

/** PUT /api/org/settings body — a merge patch; null clears a key to its env default. */
export interface OrgSettingsUpdate {
	name?: string;
	logo?: string | null;
	settings?: { [K in keyof OrgSettingsValues]?: OrgSettingsValues[K] | null };
}

// ── Topic SSOT: versions / claims / verification ─────────────────────────────

/** Normalized claim as served by GET /api/topics/[id]/claims (schema core + chain/provenance extras). */
export type TopicClaim = NormalizedClaim & {
	supersedesClaimId: string | null;
	supersededByClaimId: string | null;
	documentId: string | null;
	createdAt: string;
	updatedAt: string;
};

export type TopicVerifyReason = 'no_citation' | 'citation_unmatched' | 'not_entailed';

export interface TopicVerifySentence {
	/** JSONB claim id within the section (e.g. 's1_c0'). */
	claimId: string;
	content: string;
	reason: TopicVerifyReason;
}

export interface TopicVerifySection {
	sectionId: string;
	title: string;
	total: number;
	supported: number;
	faithfulness: number;
	unsupported: TopicVerifySentence[];
}

/** POST /api/topics/[id]/verify — strict page verification without recomposing. */
export interface TopicVerifyResult {
	ok: boolean;
	strict: boolean;
	/** false = citation check only (no NLI provider configured). */
	nliUsed: boolean;
	faithfulness: number;
	totalSentences: number;
	supportedSentences: number;
	unsupportedCount: number;
	evidenceClaims: number;
	sections: TopicVerifySection[];
	verifiedAt: string;
}

// ── Research suite: persisted projects across all four tools (B10) ───────────

export const RESEARCH_TYPES = ['argument_map', 'compare_matrix', 'report', 'timeline'] as const;
export type ResearchType = (typeof RESEARCH_TYPES)[number];

export interface ArgumentMapNode {
	id: string;
	kind: 'premise' | 'evidence' | 'conclusion';
	label: string;
	text: string;
	source?: string;
}
export interface ArgumentMapData {
	nodes: ArgumentMapNode[];
}

export type MatrixCellTone = 'default' | 'agree' | 'conflict' | 'missing';
export interface MatrixCell {
	text: string;
	tone?: MatrixCellTone;
}
export interface MatrixRow {
	id: string;
	concept: string;
	cells: MatrixCell[];
}
export interface CompareMatrixData {
	columns: string[];
	rows: MatrixRow[];
}

export interface ReportSource {
	id: string;
	label: string;
	/** SSOT topic id — its claims ground the synthesis when present. */
	topicId?: string;
}
export interface ReportData {
	prompt: string;
	strictCitation: boolean;
	sources: ReportSource[];
	body: string;
	generatedBy?: 'ai' | 'manual' | 'fallback';
	generatedAt?: string;
	wordCount?: number;
	citationCount?: number;
}

export interface TimelineEventItem {
	id: string;
	phase: string;
	stage: string;
	description: string;
	tone: 'default' | 'critical';
}
export interface TimelineData {
	events: TimelineEventItem[];
}

/** Maps a research type to its `data` blob shape. */
export interface ResearchDataByType {
	argument_map: ArgumentMapData;
	compare_matrix: CompareMatrixData;
	report: ReportData;
	timeline: TimelineData;
}

/** A persisted research project (one row serves any one tool). */
export interface ResearchProject<T extends ResearchType = ResearchType> {
	id: string;
	type: T;
	title: string;
	data: ResearchDataByType[T];
	createdAt: string;
	updatedAt: string;
}

/** POST /api/research/[id]/generate response for report projects. */
export interface ReportGenerateResult {
	ok: boolean;
	/** Present only when ok. */
	generatedBy?: 'ai' | 'fallback';
	body?: string;
	wordCount?: number;
	citationCount?: number;
	project?: ResearchProject<'report'>;
	/** Present when ok:false — an honest explanation (e.g. no evidence linked). */
	reason?: string;
}

// ── Ontology: import / schema editor / test (A11, B23) ───────────────────────

export interface OntologyConceptKind {
	kind: string;
	count: number;
	samples: { id: string; prefLabel: string; synonyms: string[] }[];
}
export interface OntologySchemaProperty {
	id: string;
	name: string;
	type: string;
	required: boolean;
	desc: string;
}
export interface OntologySchemaEntity {
	id: string;
	name: string;
	mergeStrategy: 'append' | 'review';
	properties: OntologySchemaProperty[];
}
export interface OntologySchemaView {
	id: string;
	ontology: string;
	name: string;
	status: 'active' | 'draft';
	stored: boolean;
	conceptKinds: OntologyConceptKind[];
	conceptTotal: number;
	synonymTotal: number;
	schema: { entities: OntologySchemaEntity[] };
	updatedAt: string | null;
}
export interface OntologyTestResult {
	mentionsTested: number;
	linkedCount: number;
	entities: {
		mention: string;
		conceptId: string;
		prefLabel: string;
		ontology: string;
		score: number;
		match: 'exact' | 'semantic';
	}[];
	unmatched: string[];
}

// ── Evaluation: run history + admin-managed golden set (B34, C8) ──────────────

export interface EvalRunSummary {
	id: string;
	faithfulness: number;
	citationAccuracy: number;
	hallucinationRate: number;
	noveltyPrecision: number;
	createdAt: string;
}
export interface GoldenRecord {
	id: string;
	query: string;
	expect: string;
	source: 'seed' | 'custom';
	createdAt: string;
	updatedAt: string;
}

export class ApiClient {
	constructor(private readonly options: ApiClientOptions) {}

	/** In-flight refresh, shared so concurrent 401s trigger exactly one refresh. */
	private refreshInFlight: Promise<boolean> | null = null;

	/** One-shot token refresh, de-duplicated across concurrent callers. */
	private tryRefresh(): Promise<boolean> {
		if (!this.refreshInFlight) {
			this.refreshInFlight = this.refreshSession()
				.then(() => true)
				.catch(() => false)
				.finally(() => {
					this.refreshInFlight = null;
				});
		}
		return this.refreshInFlight;
	}

	private async request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
		const fetchImpl = this.options.fetchImpl ?? fetch;
		const headers = new Headers(init.headers);
		headers.set('Accept', 'application/json');
		if (init.body) headers.set('Content-Type', 'application/json');

		const token = await this.options.getToken?.();
		if (token) headers.set('Authorization', `Bearer ${token}`);

		const response = await fetchImpl(`${this.options.baseUrl}${path}`, {
			credentials: 'include',
			...init,
			headers
		});
		// One-shot 401 recovery: refresh the session, then replay the request once.
		// Auth endpoints are exempt so a failing refresh can never recurse.
		if (response.status === 401 && retry && !path.startsWith('/api/auth/')) {
			if (await this.tryRefresh()) return this.request<T>(path, init, false);
		}
		if (!response.ok) throw new ApiError(response.status, await response.text());
		return response.json() as Promise<T>;
	}

	get baseUrl() {
		return this.options.baseUrl;
	}

	// System
	health = () => this.request<HealthResponse>('/api/health');
	session = () => this.request<SessionResponse>('/api/session');

	// Auth — session lifecycle. sign-in/up/refresh persist rotated tokens via
	// onTokens; the web path additionally relies on the server's Set-Cookie.
	private async authSuccess(path: string, input: unknown): Promise<AuthSuccess> {
		const res = await this.request<AuthSuccess>(
			path,
			{ method: 'POST', body: JSON.stringify(input) },
			false
		);
		await this.options.onTokens?.({ accessToken: res.accessToken, refreshToken: res.refreshToken });
		return res;
	}
	signIn = (input: { email: string; password: string }) =>
		this.authSuccess('/api/auth/sign-in', input);
	signUp = (input: { email: string; password: string; name: string }) =>
		this.authSuccess('/api/auth/sign-up', input);
	/** Refresh the token pair. Desktop sends the stored refresh token in the body;
	 * web relies on the refresh cookie. Throws on failure. */
	refreshSession = async (): Promise<AuthTokens> => {
		const rt = await this.options.getRefreshToken?.();
		const tokens = await this.request<AuthTokens>(
			'/api/auth/refresh',
			{ method: 'POST', body: rt ? JSON.stringify({ refreshToken: rt }) : undefined },
			false
		);
		await this.options.onTokens?.(tokens);
		return tokens;
	};
	signOut = async () => {
		const rt = await this.options.getRefreshToken?.();
		return this.request<{ ok: true }>('/api/auth/sign-out', {
			method: 'POST',
			body: rt ? JSON.stringify({ refreshToken: rt }) : undefined
		});
	};
	listAuthSessions = () => this.request<{ items: AuthSessionRow[] }>('/api/auth/sessions');
	revokeAuthSession = (token: string) =>
		this.request<{ ok: true }>('/api/auth/sessions/revoke', {
			method: 'POST',
			body: JSON.stringify({ token })
		});
	revokeOtherAuthSessions = () =>
		this.request<{ ok: true; revoked: number }>('/api/auth/sessions/revoke-others', {
			method: 'POST'
		});

	// Library
	listFolders = () => this.request<ListEnvelope<Folder>>('/api/folders').then((r) => r.items);
	getFolder = (id: string) =>
		this.request<{ folder: Folder; documents: Document[] }>(`/api/folders/${id}`);
	createFolder = (name: string) =>
		this.request<Folder>('/api/folders', { method: 'POST', body: JSON.stringify({ name }) });
	listDocuments = (folderId?: string) =>
		this.request<ListEnvelope<Document>>(
			`/api/documents${folderId ? `?folderId=${folderId}` : ''}`
		).then((r) => r.items);
	getDocument = (id: string) => this.request<Document>(`/api/documents/${id}`);
	createDocument = (input: {
		folderId: string;
		title: string;
		type: Document['type'];
		pages: number;
		storageKey?: string;
		content?: string;
	}) => this.request<Document>('/api/documents', { method: 'POST', body: JSON.stringify(input) });
	// Sources registry (A5): ids double as citation tokens for provenance/coverage.
	listSources = () => this.request<ListEnvelope<Source>>('/api/sources').then((r) => r.items);
	/** Register a source (editor+). priority: 1 = highest for conflict resolution. */
	createSource = (input: { name: string; author?: string; type?: string; priority?: number; date?: string }) =>
		this.request<Source>('/api/sources', { method: 'POST', body: JSON.stringify(input) });
	/** Edit a registered source (editor+); the id is immutable. */
	updateSource = (
		id: string,
		patch: { name?: string; author?: string; type?: string; priority?: number; date?: string }
	) => this.request<Source>(`/api/sources/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });

	// Hybrid search (FTS + vector RRF on Postgres, substring in memory)
	search = (q: string) =>
		this.request<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}`);
	presignUpload = (input: { filename: string; contentType: string; folderId: string }) =>
		this.request<{ url: string; key: string; method: string }>('/api/uploads/presign', {
			method: 'POST',
			body: JSON.stringify(input)
		});

	// Topics / SSOT
	listTopics = () => this.request<ListEnvelope<Topic>>('/api/topics').then((r) => r.items);
	getTopic = (id: string) =>
		this.request<{ topic: Topic; coverage: CoverageRow[]; delta: DeltaEntry[] }>(
			`/api/topics/${id}`
		);
	addClaim = (topicId: string, input: NewClaim) =>
		this.request<Claim>(`/api/topics/${topicId}/claims`, {
			method: 'POST',
			body: JSON.stringify(input)
		});
	/** Evidence-only recompose + verify → writes a new topic version. */
	regenerateTopic = (id: string) =>
		this.request<{ ok: boolean; faithfulness?: number; sections?: number; claims?: number; version?: number | null }>(
			`/api/topics/${id}/regenerate`,
			{ method: 'POST' }
		);
	/** Version history; pass includeSnapshot to also receive each version's sections. */
	listTopicVersions = (id: string, opts?: { includeSnapshot?: boolean }) =>
		this.request<ListEnvelope<TopicVersion & { sectionsSnapshot?: TopicSection[] }>>(
			`/api/topics/${id}/versions${opts?.includeSnapshot ? '?include=snapshot' : ''}`
		).then((r) => r.items);
	/** Write version `version`'s snapshot back to the live SSOT; records a NEW version (editor+). */
	restoreTopicVersion = (id: string, version: number) =>
		this.request<{ ok: boolean; restoredFrom: number; version: number | null; faithfulness: number | null }>(
			`/api/topics/${id}/versions/${version}/restore`,
			{ method: 'POST' }
		);
	/** Normalized claims layer: type/confidence/tags, provenance, supersede chain (A6). */
	getTopicClaims = (id: string, status?: NormalizedClaim['status']) =>
		this.request<{ items: TopicClaim[]; total: number }>(
			`/api/topics/${id}/claims${status ? `?status=${status}` : ''}`
		);
	/** Strict verification of the current page WITHOUT recomposing (B11). Read-only. */
	verifyTopic = (id: string) =>
		this.request<TopicVerifyResult>(`/api/topics/${id}/verify`, { method: 'POST' });

	// Research suite (B10) — persisted projects for all four tools (one table).
	/** List the org's research projects, optionally filtered by tool type. */
	listResearchProjects = (type?: ResearchType) =>
		this.request<ListEnvelope<ResearchProject>>(
			`/api/research${type ? `?type=${type}` : ''}`
		).then((r) => r.items);
	/** Create a project. compare_matrix seeds columns from the source registry. */
	createResearchProject = <T extends ResearchType>(type: T, title: string) =>
		this.request<ResearchProject<T>>('/api/research', {
			method: 'POST',
			body: JSON.stringify({ type, title })
		});
	/** Load one project by id (org-scoped). */
	getResearchProject = <T extends ResearchType = ResearchType>(id: string) =>
		this.request<ResearchProject<T>>(`/api/research/${id}`);
	/** Rename and/or replace the tool document. `data` is type-checked server-side. */
	updateResearchProject = <T extends ResearchType>(
		id: string,
		patch: { title?: string; data?: ResearchDataByType[T] }
	) =>
		this.request<ResearchProject<T>>(`/api/research/${id}`, {
			method: 'PATCH',
			body: JSON.stringify(patch)
		});
	deleteResearchProject = (id: string) =>
		this.request<{ ok: true }>(`/api/research/${id}`, { method: 'DELETE' });
	/**
	 * Generate a report project's body through the provider router (synthesis),
	 * grounded in the linked SSOT sources' claims (editor+). ok:false with a reason
	 * when no evidence is linked; falls back to a deterministic digest with no AI.
	 */
	generateResearchReport = (id: string) =>
		this.request<ReportGenerateResult>(`/api/research/${id}/generate`, { method: 'POST' });

	// Study / exam engine
	listFlashcards = (topicId?: string) =>
		this.request<ListEnvelope<Flashcard>>(
			`/api/flashcards${topicId ? `?topicId=${topicId}` : ''}`
		).then((r) => r.items);
	generateFlashcards = (topicId: string, count?: number) =>
		this.request<{ generated: number }>(`/api/topics/${topicId}/flashcards`, {
			method: 'POST',
			body: JSON.stringify({ count })
		});
	reviewFlashcard = (id: string, grade: 1 | 2 | 3 | 4) =>
		this.request<{ ok: boolean; state: string; dueAt: string }>(`/api/flashcards/${id}/review`, {
			method: 'POST',
			body: JSON.stringify({ grade })
		});
	/** List MCQs. Non-editors receive items WITHOUT correctOptionId/explanation — grade via attemptMcq. */
	getMcqs = (opts?: { topicId?: string; status?: 'draft' | 'published' | 'all' }) => {
		const params = new URLSearchParams();
		if (opts?.topicId) params.set('topicId', opts.topicId);
		if (opts?.status) params.set('status', opts.status);
		const qs = params.toString();
		return this.request<{
			items: (Omit<Mcq, 'correctOptionId' | 'explanation'> &
				Partial<Pick<Mcq, 'correctOptionId' | 'explanation'>> & { status?: 'draft' | 'published' })[];
			stats?: { attempts: number; correct: number; accuracy: number } | null;
			total?: number;
		}>(`/api/mcqs${qs ? `?${qs}` : ''}`);
	};
	/** @deprecated Use getMcqs — list payloads no longer include answer keys for non-editors. */
	listMcqs = (topicId?: string) =>
		this.getMcqs(topicId ? { topicId } : undefined).then((r) => r.items);
	generateMcqs = (topicId: string, count?: number) =>
		this.request<{ generated: number; status?: 'draft' | 'published' }>('/api/mcqs', {
			method: 'POST',
			body: JSON.stringify({ topicId, count })
		});
	/** Grade an answer server-side — the only place answers/explanations are revealed to learners (B13). */
	attemptMcq = (id: string, optionId: string) =>
		this.request<{
			correct: boolean;
			correctOptionId: string;
			explanation: string;
			stats: { attempts: number; correct: number; accuracy: number };
		}>(`/api/mcqs/${id}/attempt`, { method: 'POST', body: JSON.stringify({ optionId }) });
	/** Publish/unpublish an AI-generated draft MCQ (editor+). */
	setMcqStatus = (id: string, status: 'draft' | 'published') =>
		this.request<{ item: Mcq }>(`/api/mcqs/${id}`, {
			method: 'PATCH',
			body: JSON.stringify({ status })
		});
	generateCase = (topicId: string) =>
		this.request<{ case: string }>(`/api/topics/${topicId}/case`, { method: 'POST' });

	// Graph + GraphRAG communities
	getGraph = () => this.request<Graph>('/api/graph');
	listGraphCommunities = () =>
		this.request<ListEnvelope<{ id: string; label: string; size: number; nodeIds: string[] }>>(
			'/api/graph/communities'
		).then((r) => r.items);
	getGraphCommunity = (nodeId: string) =>
		this.request<{
			label: string;
			nodes: { id: string; label: string }[];
			edges: { source: string; target: string; label: string }[];
			summary?: string;
		}>(`/api/graph/community/${encodeURIComponent(nodeId)}`);

	// Review
	listReview = () => this.request<ListEnvelope<ReviewItem>>('/api/review').then((r) => r.items);
	resolveReview = (id: string, decision: 'accepted' | 'rejected') =>
		this.request<ReviewItem>(`/api/review/${id}`, {
			method: 'POST',
			body: JSON.stringify({ decision })
		});

	// Ontology
	expandOntology = (q: string) =>
		this.request<{ query: string; aliases: string[] }>(`/api/ontology/expand?q=${encodeURIComponent(q)}`);
	/** Create an empty named ontology draft (admin). */
	createOntology = (input: { name: string; slug?: string; description?: string }) =>
		this.request<{ id: string; ontology: string; name: string; entities: number; relations: number; status: 'draft' }>(
			'/api/ontologies',
			{ method: 'POST', body: JSON.stringify(input) }
		);
	/** Import concepts from a JSON / term-list / OBO payload, loading them synchronously (admin). */
	importOntology = (input: { content: string; ontology?: string; name?: string; format?: 'json' | 'terms' | 'obo' }) =>
		this.request<{
			ok: true;
			format: 'json' | 'terms' | 'obo';
			ontology: string;
			ontologyId: string;
			concepts: number;
			synonyms: number;
			edges: number;
			embeddings: number;
		}>('/api/ontologies/import', { method: 'POST', body: JSON.stringify(input) });
	/** Delete an ontology and its concepts/synonyms/embeddings/edges/schema (admin). */
	deleteOntology = (id: string) =>
		this.request<{ ok: true; ontology: string; deletedConcepts: number; deletedSynonyms: number }>(
			`/api/ontologies/${id}`,
			{ method: 'DELETE' }
		);
	/** Real ontology schema view: concept-kind dictionary + the editable entity/property/merge layer (B23). */
	getOntologySchema = (id: string) =>
		this.request<OntologySchemaView>(`/api/ontologies/${id}/schema`);
	/** Persist the editable schema layer (admin). */
	saveOntologySchema = (
		id: string,
		input: { name?: string; status?: 'active' | 'draft'; schema?: { entities: OntologySchemaEntity[] } }
	) => this.request<OntologySchemaView>(`/api/ontologies/${id}/schema`, { method: 'PUT', body: JSON.stringify(input) });
	/** Run sample text through the real ontology linker to preview what it resolves to (B23). */
	testOntology = (text: string, mentions?: string[]) =>
		this.request<OntologyTestResult>('/api/ontology/test', {
			method: 'POST',
			body: JSON.stringify({ text, mentions })
		});

	// Multi-provider AI settings
	getAiProviders = () => this.request<AiProvidersResponse>('/api/ai/providers');
	/**
	 * Org routing defaults (admin). Omitted fields are left unchanged;
	 * `defaultProvider: null` clears the default; `taskRouting` replaces the
	 * stored map. 400 on unknown provider/task ids — validate against
	 * getAiProviders().providers (kind==='chat') and taskProviders keys.
	 */
	setAiProviderSettings = (input: AiProviderSettingsInput) =>
		this.request<{ ok: true; defaultProvider: string | null; taskRouting: Record<string, string> }>(
			'/api/ai/providers',
			{ method: 'PUT', body: JSON.stringify(input) }
		);
	saveAiKey = (input: AiKeyInput) =>
		this.request<{ ok: true }>('/api/ai/keys', { method: 'POST', body: JSON.stringify(input) });
	deleteAiKey = (provider: ProviderId, scope: 'org' | 'user' = 'org') =>
		this.request<{ ok: true }>(`/api/ai/keys?provider=${provider}&scope=${scope}`, { method: 'DELETE' });

	// Graph analytics
	getGraphPageRank = () =>
		this.request<ListEnvelope<{ id: string; label: string; score: number }>>('/api/graph/pagerank').then((r) => r.items);
	// Figure / table (visual) retrieval — folderId lets the search UI deep-link to the document.
	searchFigures = (q: string) =>
		this.request<ListEnvelope<{ id: string; documentId: string; folderId: string; page: number; kind: string; content: string; title: string }>>(
			`/api/figures?q=${encodeURIComponent(q)}`
		).then((r) => r.items);
	// Document parse structure: page/dimensions, block counts by kind, coverage rollup, live job state (A7/B8).
	getDocumentStructure = (id: string) =>
		this.request<{
			source: 'postgres' | 'memory';
			hasSource: boolean;
			pages: { count: number; width: number | null; height: number | null } | null;
			blocks: { total: number; byKind: Record<string, number> } | null;
			coverage: {
				total: number;
				byStatus: Record<string, number>;
				unaccountedPct: number;
				chunkedPct: number;
				claimedPct: number;
			} | null;
			chunks: number | null;
			job: {
				id: string;
				stage: string;
				progress: number;
				message: string | null;
				startedAt: string | null;
				stages: Record<string, string> | null;
			} | null;
		}>(`/api/documents/${id}/structure`);
	/** Presigned S3 GET url for the original uploaded file (B8). Browser tabs can hit the raw endpoint (302 redirect). */
	getDocumentDownloadUrl = (id: string) =>
		this.request<{ url: string; expiresIn: number | null }>(
			`/api/documents/${id}/download?format=json`
		);

	// Hosted-tier admin: processing control
	cancelJob = (id: string) => this.request<{ ok: true }>(`/api/processing/${id}/cancel`, { method: 'POST' });
	retryJob = (id: string) => this.request<{ ok: true }>(`/api/processing/${id}/retry`, { method: 'POST' });
	reindex = () => this.request<{ reembedded: number; remaining: boolean }>('/api/admin/reindex', { method: 'POST' });

	// Preferences
	getPreferences = () => this.request<{ prefs: Record<string, unknown> }>('/api/preferences').then((r) => r.prefs);
	savePreferences = (prefs: Record<string, unknown>) =>
		this.request<{ ok: true }>('/api/preferences', { method: 'PATCH', body: JSON.stringify(prefs) });

	// User admin
	updateUser = (id: string, patch: { role?: string; status?: string }) =>
		this.request<{ id: string; role: string; status: string }>(`/api/users/${id}`, {
			method: 'PATCH',
			body: JSON.stringify(patch)
		});
	/** Real directory (app users enriched with better-auth account state) + pending invitations (admin). */
	listUserDirectory = () =>
		this.request<{
			items: (User & {
				status?: 'active' | 'suspended';
				emailVerified?: boolean | null;
				createdAt?: string | null;
			})[];
			invitations: {
				id: string;
				email: string;
				role: string;
				status: 'pending' | 'expired';
				createdAt: string;
				expiresAt: string;
				inviteUrl: string;
			}[];
			total: number;
		}>('/api/users');
	/** Create/refresh an invitation. emailSent=false → hand over inviteUrl manually (no SMTP transport). */
	inviteUser = (email: string, role: string) =>
		this.request<{
			id: string;
			email: string;
			role: string;
			status: string;
			expiresAt: string;
			inviteUrl: string;
			emailSent: boolean;
		}>('/api/users', { method: 'POST', body: JSON.stringify({ action: 'invite', email, role }) });
	revokeInvite = (invitationId: string) =>
		this.request<{ ok: true }>('/api/users', {
			method: 'POST',
			body: JSON.stringify({ action: 'revoke-invite', invitationId })
		});
	/** Issue a one-time temporary password and revoke the user's sessions (admin). */
	resetUserPassword = (id: string) =>
		this.request<{ ok: true; tempPassword: string }>(`/api/users/${id}`, {
			method: 'POST',
			body: JSON.stringify({ action: 'reset-password' })
		});
	/** Force logout everywhere (admin). */
	revokeUserSessions = (id: string) =>
		this.request<{ ok: true; revoked: number }>(`/api/users/${id}`, {
			method: 'POST',
			body: JSON.stringify({ action: 'revoke-sessions' })
		});

	// API keys
	listApiKeys = () =>
		this.request<ListEnvelope<{ id: string; name: string; tokenHint: string; createdAt: string; lastUsedAt: string | null }>>(
			'/api/api-keys'
		).then((r) => r.items);
	createApiKey = (name: string) =>
		this.request<{ id: string; name: string; token: string; tokenHint: string }>('/api/api-keys', {
			method: 'POST',
			body: JSON.stringify({ name })
		});
	deleteApiKey = (id: string) => this.request<{ ok: true }>(`/api/api-keys/${id}`, { method: 'DELETE' });

	// Webhooks
	/** Items-only list (legacy callers). Use getWebhooks for delivery status + the supported-events selector. */
	listWebhooks = () =>
		this.getWebhooks().then((r) => r.items);
	/** Full envelope: endpoints (with delivery status) + the set of subscribable event names. */
	getWebhooks = () =>
		this.request<{ items: WebhookEndpoint[]; total: number; events: string[] }>('/api/webhooks');
	/** Create an endpoint. `secret` is the ONE-TIME reveal of the HMAC signing secret (null pre-migration). */
	createWebhook = (url: string, event?: string) =>
		this.request<{ id: string; url: string; event: string; active: boolean; secret: string | null; signing: string }>(
			'/api/webhooks',
			{ method: 'POST', body: JSON.stringify({ url, event }) }
		);
	/** Edit url / event / active toggle (editor+). */
	updateWebhook = (id: string, patch: { url?: string; event?: string; active?: boolean }) =>
		this.request<WebhookEndpoint>(`/api/webhooks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
	/** Fire a signed test delivery and report the endpoint's response (editor+). */
	testWebhook = (id: string) =>
		this.request<WebhookTestResult>(`/api/webhooks/${id}/test`, { method: 'POST' });
	deleteWebhook = (id: string) => this.request<{ ok: true }>(`/api/webhooks/${id}`, { method: 'DELETE' });

	// Notifications
	archiveNotification = (id: string) => this.request<{ ok: true }>(`/api/notifications/${id}/archive`, { method: 'POST' });
	/** Per-item mark read/unread (and optionally archive) — persists server-side (B29). */
	updateNotification = (id: string, patch: { read?: boolean; archived?: boolean }) =>
		this.request<{ ok: true; id: string; read: boolean; archived?: boolean; archivedPersisted?: boolean }>(
			`/api/notifications/${id}`,
			{ method: 'PATCH', body: JSON.stringify(patch) }
		);

	// Billing (Stripe)
	getBillingStatus = () =>
		this.request<{ configured: boolean; plan: string; status: string; currentPeriodEnd: string | null; hasCustomer: boolean }>(
			'/api/billing/status'
		);
	billingCheckout = () => this.request<{ url: string }>('/api/billing/checkout', { method: 'POST' });
	billingPortal = () => this.request<{ url: string }>('/api/billing/portal', { method: 'POST' });
	/** Recent invoices from Stripe (amounts in smallest currency unit). Empty when Stripe unconfigured. */
	getBillingInvoices = () =>
		this.request<{
			configured: boolean;
			invoices: Array<{
				id: string;
				number: string | null;
				created: number;
				total: number;
				currency: string;
				status: string;
				hostedInvoiceUrl: string | null;
				invoicePdf: string | null;
			}>;
		}>('/api/billing/invoices');

	// Org settings (workspace identity + governance/pipeline/search configuration)
	getOrgSettings = () => this.request<OrgSettingsResponse>('/api/org/settings');
	updateOrgSettings = (input: OrgSettingsUpdate) =>
		this.request<OrgSettingsResponse>('/api/org/settings', { method: 'PUT', body: JSON.stringify(input) });

	// Super-admin platform console (all RequireSuperAdmin on the server).
	getSystemSettings = () => this.request<SystemSettingsResponse>('/api/admin/system-settings');
	updateSystemSettings = (patch: {
		queue?: Partial<SystemSettingsValues['queue']>;
		rateLimit?: Partial<SystemSettingsValues['rateLimit']>;
		auth?: Partial<SystemSettingsValues['auth']>;
		pipeline?: Partial<SystemSettingsValues['pipeline']>;
		pricing?: Partial<SystemSettingsValues['pricing']>;
	}) =>
		this.request<SystemSettingsResponse>('/api/admin/system-settings', {
			method: 'PUT',
			body: JSON.stringify(patch)
		});
	listAdminOrgs = () => this.request<{ items: AdminOrgSummary[]; total: number }>('/api/admin/orgs');
	updateAdminOrg = (id: string, patch: { plan?: string; suspended?: boolean; name?: string }) =>
		this.request<{ id: string; name: string; plan: string; suspended: boolean }>(
			`/api/admin/orgs/${id}`,
			{ method: 'PATCH', body: JSON.stringify(patch) }
		);
	listAdminPlans = () => this.request<{ items: AdminPlan[]; total: number }>('/api/admin/plans');
	upsertAdminPlan = (plan: {
		id: string;
		name: string;
		seats?: number;
		documentCap?: number;
		aiBudgetUsd?: number;
		stripePriceId?: string;
		features?: unknown;
		active?: boolean;
	}) => this.request<AdminPlan>('/api/admin/plans', { method: 'POST', body: JSON.stringify(plan) });
	getAdminOverview = () =>
		this.request<{ orgs: number; suspended: number; byPlan: { plan: string; count: number }[] }>(
			'/api/admin/overview'
		);

	// Admin
	/** Usage metering aggregates; period defaults to the current calendar month. */
	getUsage = (period?: 'month' | 'all') =>
		this.request<UsageMetrics>(`/api/usage${period ? `?period=${period}` : ''}`);
	/** Latest metrics + recent-run history (newest-first) for trend deltas (B34). */
	getEvaluation = (historyLimit?: number) =>
		this.request<EvaluationMetrics & { history: EvalRunSummary[] }>(
			`/api/evaluation${historyLimit ? `?history=${historyLimit}` : ''}`
		);
	runEvaluation = () => this.request<EvaluationMetrics>('/api/evaluation/run', { method: 'POST' });
	// Golden evaluation set (C8): admin-managed, seeded from the bundled set on first read.
	listGolden = () => this.request<ListEnvelope<GoldenRecord>>('/api/evaluation/golden').then((r) => r.items);
	createGolden = (input: { query: string; expect: string }) =>
		this.request<GoldenRecord>('/api/evaluation/golden', { method: 'POST', body: JSON.stringify(input) });
	updateGolden = (id: string, patch: { query?: string; expect?: string }) =>
		this.request<GoldenRecord>(`/api/evaluation/golden/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
	deleteGolden = (id: string) =>
		this.request<{ ok: true }>(`/api/evaluation/golden/${id}`, { method: 'DELETE' });
	listProcessing = () =>
		this.request<ListEnvelope<ProcessingJob>>('/api/processing').then((r) => r.items);
	/** Real pipeline rollups: queue/stage counts, throughput, avg durations (B16). */
	getProcessingStats = () => this.request<ProcessingStats>('/api/processing/stats');
	/** Cheap graph counts (nodes/edges/communities/groups) — avoids fetching the full graph (B16/A3). */
	getGraphStats = () => this.request<GraphStats>('/api/graph/stats');
	/** Real storage numbers: DB size, per-table sizes, org-scoped counts, S3 prefix usage (C7). */
	getStorageStats = () =>
		this.request<{
			source: 'postgres' | 'memory';
			database: { totalBytes: number | null; tables: Record<string, number | null> } | null;
			counts: {
				documents: number | null;
				chunks: number | null;
				embeddedChunks: number | null;
				docBlocks: number | null;
				graphNodes: number | null;
				graphEdges: number | null;
				claims: number | null;
			};
			s3: {
				configured: boolean;
				prefix?: string;
				bytes: number | null;
				objects: number | null;
				truncated?: boolean;
				cachedAt?: string | null;
			};
		}>('/api/admin/storage-stats');
	listAudit = () => this.request<ListEnvelope<AuditLog>>('/api/audit').then((r) => r.items);
	/** Server-side paginated + filtered audit log (B32). `total` is the filtered count for pager math. */
	listAuditPaged = (params?: {
		limit?: number;
		offset?: number;
		from?: string;
		to?: string;
		action?: string;
		actor?: string;
		severity?: 'info' | 'warning' | 'critical';
	}) => {
		const qs = new URLSearchParams();
		if (params) {
			for (const [k, v] of Object.entries(params)) {
				if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
			}
		}
		const q = qs.toString();
		return this.request<{ items: AuditLog[]; total: number; limit: number; offset: number }>(
			`/api/audit${q ? `?${q}` : ''}`
		);
	};
	listOntologies = () =>
		this.request<ListEnvelope<Ontology>>('/api/ontologies').then((r) => r.items);
	listUsers = () => this.request<ListEnvelope<User>>('/api/users').then((r) => r.items);

	// Notifications
	listNotifications = () =>
		this.request<ListEnvelope<Notification>>('/api/notifications').then((r) => r.items);
	markAllNotificationsRead = () => this.request<{ ok: true }>('/api/notifications', { method: 'POST' });

	// Copilot — returns the raw Response so callers can read the SSE stream.
	copilotStream = async (input: {
		mode: CopilotMode;
		message: string;
		topicId?: string;
		attachment?: CopilotAttachment;
	}) => {
		const fetchImpl = this.options.fetchImpl ?? fetch;
		const send = async () => {
			const headers = new Headers({
				'Content-Type': 'application/json',
				Accept: 'text/event-stream'
			});
			const token = await this.options.getToken?.();
			if (token) headers.set('Authorization', `Bearer ${token}`);
			const aiToken = await this.options.getAiToken?.();
			if (aiToken) headers.set('x-ai-oauth-token', aiToken);
			return fetchImpl(`${this.options.baseUrl}/api/copilot`, {
				method: 'POST',
				credentials: 'include',
				headers,
				body: JSON.stringify(input)
			});
		};
		// Mirror request()'s one-shot 401→refresh→retry for the streaming path.
		let response = await send();
		if (response.status === 401 && (await this.tryRefresh())) response = await send();
		return response;
	};
}

/** Consume an SSE Response body, invoking onChunk per parsed data frame. */
export async function readSSE<T = unknown>(
	response: Response,
	onChunk: (data: T) => void
): Promise<void> {
	if (!response.body) return;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const parts = buffer.split('\n\n');
		buffer = parts.pop() ?? '';
		for (const part of parts) {
			const line = part.split('\n').find((l) => l.startsWith('data:'));
			if (!line) continue;
			try {
				onChunk(JSON.parse(line.slice(5).trim()) as T);
			} catch {
				/* ignore malformed frame */
			}
		}
	}
}
