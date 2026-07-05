import type {
	AiKeyInput,
	AiProviderSettingsInput,
	AiProvidersResponse,
	AuditLog,
	Claim,
	CopilotMode,
	CoverageRow,
	DeltaEntry,
	Document,
	EvaluationMetrics,
	Flashcard,
	Folder,
	Graph,
	HealthResponse,
	Mcq,
	NewClaim,
	Notification,
	Ontology,
	ProcessingJob,
	ProviderId,
	ReviewItem,
	SearchResponse,
	SessionResponse,
	Source,
	Topic,
	TopicVersion,
	UsageMetrics,
	User
} from '@insightlibrary/schemas';

export interface ApiClientOptions {
	/** e.g. http://localhost:5174 in dev, https://api.insightlibrary.ai in prod */
	baseUrl: string;
	/** Bearer token supplier (Tauri: OS keyring). Web relies on cookies instead. */
	getToken?: () => Promise<string | null>;
	/** Optional forwarded AI OAuth token (desktop ChatGPT subscription) for copilot. */
	getAiToken?: () => Promise<string | null>;
	fetchImpl?: typeof fetch;
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

export class ApiClient {
	constructor(private readonly options: ApiClientOptions) {}

	private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
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
		if (!response.ok) throw new ApiError(response.status, await response.text());
		return response.json() as Promise<T>;
	}

	get baseUrl() {
		return this.options.baseUrl;
	}

	// System
	health = () => this.request<HealthResponse>('/api/health');
	session = () => this.request<SessionResponse>('/api/session');

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
	listSources = () => this.request<ListEnvelope<Source>>('/api/sources').then((r) => r.items);

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
	listTopicVersions = (id: string) =>
		this.request<ListEnvelope<TopicVersion>>(`/api/topics/${id}/versions`).then((r) => r.items);

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
	// Figure / table (visual) retrieval
	searchFigures = (q: string) =>
		this.request<ListEnvelope<{ id: string; documentId: string; page: number; kind: string; content: string; title: string }>>(
			`/api/figures?q=${encodeURIComponent(q)}`
		).then((r) => r.items);

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
	listWebhooks = () =>
		this.request<ListEnvelope<{ id: string; url: string; event: string; active: boolean }>>('/api/webhooks').then((r) => r.items);
	createWebhook = (url: string, event?: string) =>
		this.request<{ id: string; url: string; event: string; active: boolean }>('/api/webhooks', {
			method: 'POST',
			body: JSON.stringify({ url, event })
		});
	deleteWebhook = (id: string) => this.request<{ ok: true }>(`/api/webhooks/${id}`, { method: 'DELETE' });

	// Notifications
	archiveNotification = (id: string) => this.request<{ ok: true }>(`/api/notifications/${id}/archive`, { method: 'POST' });

	// Billing (Stripe)
	getBillingStatus = () =>
		this.request<{ configured: boolean; plan: string; status: string; currentPeriodEnd: string | null; hasCustomer: boolean }>(
			'/api/billing/status'
		);
	billingCheckout = () => this.request<{ url: string }>('/api/billing/checkout', { method: 'POST' });
	billingPortal = () => this.request<{ url: string }>('/api/billing/portal', { method: 'POST' });

	// Org settings (workspace identity + governance/pipeline/search configuration)
	getOrgSettings = () => this.request<OrgSettingsResponse>('/api/org/settings');
	updateOrgSettings = (input: OrgSettingsUpdate) =>
		this.request<OrgSettingsResponse>('/api/org/settings', { method: 'PUT', body: JSON.stringify(input) });

	// Admin
	/** Usage metering aggregates; period defaults to the current calendar month. */
	getUsage = (period?: 'month' | 'all') =>
		this.request<UsageMetrics>(`/api/usage${period ? `?period=${period}` : ''}`);
	getEvaluation = () => this.request<EvaluationMetrics>('/api/evaluation');
	runEvaluation = () => this.request<EvaluationMetrics>('/api/evaluation/run', { method: 'POST' });
	listProcessing = () =>
		this.request<ListEnvelope<ProcessingJob>>('/api/processing').then((r) => r.items);
	listAudit = () => this.request<ListEnvelope<AuditLog>>('/api/audit').then((r) => r.items);
	listOntologies = () =>
		this.request<ListEnvelope<Ontology>>('/api/ontologies').then((r) => r.items);
	listUsers = () => this.request<ListEnvelope<User>>('/api/users').then((r) => r.items);

	// Notifications
	listNotifications = () =>
		this.request<ListEnvelope<Notification>>('/api/notifications').then((r) => r.items);
	markAllNotificationsRead = () => this.request<{ ok: true }>('/api/notifications', { method: 'POST' });

	// Copilot — returns the raw Response so callers can read the SSE stream.
	copilotStream = async (input: { mode: CopilotMode; message: string; topicId?: string }) => {
		const fetchImpl = this.options.fetchImpl ?? fetch;
		const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'text/event-stream' });
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
