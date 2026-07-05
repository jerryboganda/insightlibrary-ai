import { z } from 'zod';

export const healthResponseSchema = z.object({
	status: z.literal('ok'),
	service: z.string(),
	version: z.string(),
	dataSource: z.enum(['postgres', 'memory']),
	time: z.iso.datetime()
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** Generic list envelope. */
export function listResponseSchema<T extends z.ZodTypeAny>(item: T) {
	return z.object({
		items: z.array(item),
		total: z.number().int().nonnegative()
	});
}

export const sessionUserSchema = z.object({
	id: z.string(),
	name: z.string(),
	email: z.email(),
	role: z.enum(['owner', 'admin', 'editor', 'viewer']),
	orgId: z.string(),
	orgName: z.string(),
	tenantId: z.string()
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const sessionResponseSchema = z.object({
	authenticated: z.boolean(),
	user: sessionUserSchema.nullable()
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

// ── AI copilot ──────────────────────────────────────────────────────────────
export const copilotModeSchema = z.enum([
	'ask',
	'strict_citation',
	'research',
	'compare',
	'contradiction',
	'study',
	'teacher',
	'exam',
	'summarize',
	'deep_reasoning',
	'fast_answer',
	'ssot',
	'delta'
]);
export type CopilotMode = z.infer<typeof copilotModeSchema>;

export const copilotRequestSchema = z.object({
	mode: copilotModeSchema,
	message: z.string().min(1),
	topicId: z.string().optional()
});
export type CopilotRequest = z.infer<typeof copilotRequestSchema>;

/** One SSE frame from the copilot stream. */
export const copilotChunkSchema = z.object({
	type: z.enum(['token', 'citation', 'done', 'error']),
	value: z.string()
});
export type CopilotChunk = z.infer<typeof copilotChunkSchema>;

// ── Hybrid search ─────────────────────────────────────────────────────────
export const searchResultSchema = z.object({
	kind: z.enum(['topic', 'document', 'folder', 'chunk']),
	id: z.string(),
	title: z.string(),
	snippet: z.string(),
	href: z.string(),
	/** Fused relevance score (RRF for the Postgres path). */
	score: z.number()
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const searchResponseSchema = z.object({
	query: z.string(),
	results: z.array(searchResultSchema),
	total: z.number().int().nonnegative(),
	/** 'hybrid' = FTS+vector RRF (Postgres); 'text' = substring (in-memory). */
	mode: z.enum(['hybrid', 'text'])
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

// ── SSOT claim authoring ────────────────────────────────────────────────────
export const newClaimSchema = z.object({
	sectionId: z.string(),
	content: z.string().min(1),
	citations: z.array(z.string())
});
export type NewClaim = z.infer<typeof newClaimSchema>;

// ── Multi-provider LLM management ───────────────────────────────────────────
export const providerIdSchema = z.enum([
	'gemini',
	'anthropic',
	'openai',
	'moonshot',
	'deepseek',
	'minimax',
	'openai-compatible'
]);
export type ProviderId = z.infer<typeof providerIdSchema>;

/** One provider's status for the settings UI (never includes the key itself). */
export const providerInfoSchema = z.object({
	id: providerIdSchema,
	label: z.string(),
	/** A server-side env key is present. */
	envConfigured: z.boolean(),
	/** An org/user key is stored in the DB. */
	keyStored: z.boolean(),
	hint: z.string(),
	model: z.string().nullable(),
	supportsEmbeddings: z.boolean()
});
export type ProviderInfo = z.infer<typeof providerInfoSchema>;

export const aiProvidersResponseSchema = z.object({
	providers: z.array(providerInfoSchema),
	activeChatProvider: z.string(),
	encryptionAvailable: z.boolean()
});
export type AiProvidersResponse = z.infer<typeof aiProvidersResponseSchema>;

export const aiKeyInputSchema = z.object({
	provider: providerIdSchema,
	apiKey: z.string().min(1),
	baseUrl: z.string().url().optional(),
	model: z.string().optional(),
	/** 'org' (shared, admin) or 'user' (personal, web BYO). Defaults to 'org'. */
	scope: z.enum(['org', 'user']).default('org')
});
export type AiKeyInput = z.infer<typeof aiKeyInputSchema>;
