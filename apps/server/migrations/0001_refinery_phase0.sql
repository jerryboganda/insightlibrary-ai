-- Phase 0 — refinery foundations (ADDITIVE ONLY, idempotent).
-- Safe to run against the live push-created DB: every statement uses IF NOT
-- EXISTS and never drops/retypes an existing column. Applied by db:migrate.

CREATE EXTENSION IF NOT EXISTS vector;

-- ── First-class claims + provenance ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS claims (
	id text PRIMARY KEY,
	org_id text NOT NULL REFERENCES organizations(id),
	topic_id text REFERENCES topics(id),
	section_id text,
	jsonb_claim_id text,
	document_id text REFERENCES documents(id),
	claim_type text NOT NULL DEFAULT 'fact',
	claim_text text NOT NULL,
	normalized_meaning vector(768),
	ontology_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	system_tags jsonb NOT NULL DEFAULT '[]'::jsonb,
	exam_tags jsonb NOT NULL DEFAULT '[]'::jsonb,
	confidence real NOT NULL DEFAULT 0.5,
	status text NOT NULL DEFAULT 'active',
	supersedes_claim_id text,
	created_at timestamp NOT NULL DEFAULT now(),
	updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS claims_org_topic_idx ON claims (org_id, topic_id);
CREATE INDEX IF NOT EXISTS claims_topic_section_idx ON claims (topic_id, section_id);
CREATE INDEX IF NOT EXISTS claims_nm_hnsw ON claims USING hnsw (normalized_meaning vector_cosine_ops);

CREATE TABLE IF NOT EXISTS claim_sources (
	id text PRIMARY KEY,
	claim_id text NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
	source_id text REFERENCES sources(id),
	source_ref text,
	locator text,
	document_id text REFERENCES documents(id),
	chunk_id text REFERENCES chunks(id),
	block_id text,
	stance text NOT NULL DEFAULT 'supports'
);
CREATE INDEX IF NOT EXISTS claim_sources_claim_idx ON claim_sources (claim_id);

-- ── Topic versions ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS topic_versions (
	id text PRIMARY KEY,
	topic_id text NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
	org_id text NOT NULL REFERENCES organizations(id),
	version integer NOT NULL,
	page_md text NOT NULL DEFAULT '',
	sections_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
	changelog jsonb NOT NULL DEFAULT '[]'::jsonb,
	faithfulness real,
	created_by text,
	created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS topic_versions_topic_version_uq ON topic_versions (topic_id, version);

-- ── MCQs ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mcqs (
	id text PRIMARY KEY,
	org_id text NOT NULL REFERENCES organizations(id),
	topic_id text NOT NULL REFERENCES topics(id),
	claim_id text REFERENCES claims(id),
	stem text NOT NULL,
	options jsonb NOT NULL DEFAULT '[]'::jsonb,
	correct_option_id text NOT NULL,
	explanation text NOT NULL DEFAULT '',
	difficulty text NOT NULL DEFAULT 'medium',
	exam_tags jsonb NOT NULL DEFAULT '[]'::jsonb,
	status text NOT NULL DEFAULT 'draft',
	created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mcqs_topic_idx ON mcqs (topic_id);

-- ── Flashcards: spaced-repetition columns ───────────────────────────────────
ALTER TABLE flashcards ADD COLUMN IF NOT EXISTS source_claim_id text;
ALTER TABLE flashcards ADD COLUMN IF NOT EXISTS due_at timestamp;
ALTER TABLE flashcards ADD COLUMN IF NOT EXISTS interval_days real NOT NULL DEFAULT 0;
ALTER TABLE flashcards ADD COLUMN IF NOT EXISTS ease_factor real NOT NULL DEFAULT 2.5;
ALTER TABLE flashcards ADD COLUMN IF NOT EXISTS stability real NOT NULL DEFAULT 0;
ALTER TABLE flashcards ADD COLUMN IF NOT EXISTS difficulty real NOT NULL DEFAULT 0;
ALTER TABLE flashcards ADD COLUMN IF NOT EXISTS repetitions integer NOT NULL DEFAULT 0;
ALTER TABLE flashcards ADD COLUMN IF NOT EXISTS lapses integer NOT NULL DEFAULT 0;
ALTER TABLE flashcards ADD COLUMN IF NOT EXISTS last_reviewed_at timestamp;
ALTER TABLE flashcards ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'new';

-- ── Graph: semantic columns ─────────────────────────────────────────────────
ALTER TABLE graph_nodes ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'concept';
ALTER TABLE graph_nodes ADD COLUMN IF NOT EXISTS label text NOT NULL DEFAULT '';
ALTER TABLE graph_nodes ADD COLUMN IF NOT EXISTS canonical_concept_id text;
ALTER TABLE graph_nodes ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE graph_edges ADD COLUMN IF NOT EXISTS rel text NOT NULL DEFAULT '';
ALTER TABLE graph_edges ADD COLUMN IF NOT EXISTS weight real NOT NULL DEFAULT 1;
ALTER TABLE graph_edges ADD COLUMN IF NOT EXISTS source_claim_id text;

-- ── Multi-provider LLM credentials ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS provider_keys (
	id text PRIMARY KEY,
	org_id text NOT NULL REFERENCES organizations(id),
	provider text NOT NULL,
	api_key_enc text NOT NULL,
	base_url text,
	model text,
	hint text NOT NULL DEFAULT '',
	created_at timestamp NOT NULL DEFAULT now(),
	updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS provider_keys_org_provider_uq ON provider_keys (org_id, provider);

CREATE TABLE IF NOT EXISTS provider_settings (
	org_id text PRIMARY KEY REFERENCES organizations(id),
	default_provider text,
	task_routing jsonb NOT NULL DEFAULT '{}'::jsonb,
	updated_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_ai_credentials (
	id text PRIMARY KEY,
	user_id text NOT NULL,
	provider text NOT NULL,
	api_key_enc text NOT NULL,
	base_url text,
	model text,
	hint text NOT NULL DEFAULT '',
	created_at timestamp NOT NULL DEFAULT now(),
	updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS user_ai_credentials_user_provider_uq ON user_ai_credentials (user_id, provider);
