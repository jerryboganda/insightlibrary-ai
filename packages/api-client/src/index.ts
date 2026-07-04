import type {
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
	NewClaim,
	Notification,
	Ontology,
	ProcessingJob,
	ReviewItem,
	SearchResponse,
	SessionResponse,
	Source,
	Topic,
	UsageMetrics,
	User
} from '@insightlibrary/schemas';

export interface ApiClientOptions {
	/** e.g. http://localhost:5174 in dev, https://api.insightlibrary.ai in prod */
	baseUrl: string;
	/** Bearer token supplier (Tauri: OS keyring). Web relies on cookies instead. */
	getToken?: () => Promise<string | null>;
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

	// Study
	listFlashcards = (topicId?: string) =>
		this.request<ListEnvelope<Flashcard>>(
			`/api/flashcards${topicId ? `?topicId=${topicId}` : ''}`
		).then((r) => r.items);

	// Graph
	getGraph = () => this.request<Graph>('/api/graph');

	// Review
	listReview = () => this.request<ListEnvelope<ReviewItem>>('/api/review').then((r) => r.items);
	resolveReview = (id: string, decision: 'accepted' | 'rejected') =>
		this.request<ReviewItem>(`/api/review/${id}`, {
			method: 'POST',
			body: JSON.stringify({ decision })
		});

	// Admin
	getUsage = () => this.request<UsageMetrics>('/api/usage');
	getEvaluation = () => this.request<EvaluationMetrics>('/api/evaluation');
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
