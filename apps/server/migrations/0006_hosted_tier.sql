-- Phase 5 (hosted tier) — API keys, preferences, webhooks, user status.
-- ADDITIVE ONLY, idempotent.

ALTER TABLE users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

CREATE TABLE IF NOT EXISTS api_keys (
	id text PRIMARY KEY,
	org_id text NOT NULL REFERENCES organizations(id),
	name text NOT NULL,
	token_hash text NOT NULL,
	token_hint text NOT NULL DEFAULT '',
	created_by text,
	created_at timestamp NOT NULL DEFAULT now(),
	last_used_at timestamp
);
CREATE INDEX IF NOT EXISTS api_keys_org_idx ON api_keys (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_token_hash_uq ON api_keys (token_hash);

CREATE TABLE IF NOT EXISTS user_preferences (
	user_id text PRIMARY KEY,
	prefs jsonb NOT NULL DEFAULT '{}'::jsonb,
	updated_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhooks (
	id text PRIMARY KEY,
	org_id text NOT NULL REFERENCES organizations(id),
	url text NOT NULL,
	event text NOT NULL DEFAULT '*',
	active boolean NOT NULL DEFAULT true,
	created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhooks_org_idx ON webhooks (org_id);
