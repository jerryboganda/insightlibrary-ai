# Existing frontend API surface (compatibility reference)

Inventoried 2026-07-06 from the live `insightlibrary/` monorepo (apps/app + packages/api-client
+ packages/schemas + apps/server). The Rust `insight-api` should preserve these contracts
wherever practical so the existing Svelte 5 UI can be rewired with minimal churn (FE-A).

## Non-negotiable compatibility points

- All client calls go to **`/api/*`** paths (e.g. `/api/documents`, `/api/uploads/presign`).
- **Presign**: `POST /api/uploads/presign` `{ filename, contentType, folderId }` →
  `{ url, key, method: "PUT" }`; client PUTs directly to MinIO public endpoint.
- **List envelope**: collection endpoints return `ListEnvelope<T>` (items + paging metadata).
- **Session**: `GET /api/session` → `{ authenticated, user?, org? }`.
- **Health**: `GET /api/health` → `{ status: "ok", service, version, dataSource, time }`.
- **Auth**: today better-auth session cookie (`better-auth.session_token`, HTTP-only) on web;
  **Bearer token from OS keyring on Tauri desktop** (api-client `getToken()` hook). The Rust
  JWT auth should accept a Bearer token AND set/read an HTTP-only cookie so both shells work.
- **Copilot/tutor streaming**: `POST /api/copilot` responds with an SSE stream of
  `CopilotChunk` frames `{ type: start|text|context|meta|end, content?, meta? }`,
  modes: ask | strict_citation | research | compare | ssot | delta.
- **Search**: `GET /api/search?q=` → `{ results: [{kind: claim|chunk|topic, id, title?, snippet, href, confidence}], total, tookMs }`
  (camelCase, matching the rest of the surface — `contentType`/`folderId`/`lastUpdated`; the impl emits `tookMs`).
- **Embeddings**: existing vectors are **768-dim** (gemini-embedding-001) — the new chunks
  table is vector(768); keep dimension parity.
- **AI providers**: org/user BYO keys with `{ provider, key, scope: org|user }` shape;
  providers: gemini | openai | anthropic | openai-compatible | kimi | deepseek | minimax.

## Endpoint inventory the Rust API must eventually cover (FE-A gap matrix seed)

Auth: /api/auth/sign-in, sign-up, sign-out, session (better-auth today).
Core: /api/health, /api/session, /api/folders (+/{id}), /api/documents (+/{id}, /download,
/structure), /api/sources (+PATCH), /api/uploads/presign, /api/search.
Topics/SSOT: /api/topics (+/{id}), /{id}/claims (GET+POST), /{id}/verify, /{id}/regenerate,
/{id}/versions (+restore), /{id}/case, /{id}/flashcards.
Study: /api/flashcards (+/{id}/review grade 1-4), /api/mcqs (+POST, PATCH status,
/{id}/attempt).
Research: /api/research (+POST, DELETE, /{id}/generate) — types: argument_map,
compare_matrix, report, timeline.
Graph: /api/graph, /communities, /community/{id}, /pagerank, /stats.
Review queue: /api/review (+POST /{id} accept/reject).
Ontology: /api/ontology/expand, /test; /api/ontologies (+DELETE, /{id}/schema GET/PUT, /import).
AI: /api/ai/providers (GET/PUT), /api/ai/keys (POST/DELETE).
Ops: /api/processing/{id}/cancel|retry, /api/admin/reindex, /api/preferences (GET/PATCH),
/api/users (GET/POST invite), /api/audit, /api/webhooks (+/{id}/test).
Streaming: /api/copilot (SSE POST).

## Schema shapes to mirror (packages/schemas)

Folder {id,name,docs,topics,health 0-100,lastUpdated}; Document {id,folderId,title,status
indexed|processing|needs_review|failed,statusLabel,type pdf|docx|epub,pages,topics,uploadedAt};
Topic {id,name,aliases[],health,updates,sections[],createdAt}; TopicSection {id,title,icon,
claims[]}; NormalizedClaim {…,topicId?,sectionId?,status,confidence,divergence};
TopicVersion {id,topicId,version,pageMd,snapshot?,createdBy?,createdAt};
Flashcard {id,topicId,topic,front,back,interval,repetitions,nextReview};
Mcq {id,topicId,claimId?,stem,options[{id,text}],answer,explanation};
ProcessingJob {id,documentId,documentTitle,stage,progress,error?,estimatedMins,createdAt};
SessionUser/Organization/Role owner|admin|editor|viewer; Notification; AuditLog;
WebhookEndpoint. See packages/schemas for full Zod definitions.

## Today's backend internals being replaced (apps/server)

better-auth + Drizzle ORM + pg-boss queue + AWS SDK v3 presign + multi-provider LLM router
(getOrgAiRouting: org key → env fallback) + gemini 768-dim embeddings + SSE copilot.
Dev fallback: in-memory mode when DATABASE_URL unset (seeded admin usr_dev).
