-- Phase 8: BYO provider keys + usage metering metadata. Additive only.

-- Extend the (schema-only) BYO key table so a key can be scoped to a single
-- user or shared org-wide, and carry a non-secret hint (e.g. last 4 chars) for
-- display. Existing rows default to org scope.
ALTER TABLE user_provider_keys ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE user_provider_keys ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'org'
    CHECK (scope IN ('org', 'user'));
ALTER TABLE user_provider_keys ADD COLUMN IF NOT EXISTS key_hint text;
ALTER TABLE user_provider_keys ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- One key per (tenant, provider, scope, user). Org-scope rows share a NULL
-- user_id; a partial unique index enforces one org key per provider, and one
-- user key per (provider, user).
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_keys_org
    ON user_provider_keys (tenant_id, provider) WHERE scope = 'org';
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_keys_user
    ON user_provider_keys (tenant_id, provider, user_id) WHERE scope = 'user';

-- Per-call metering metadata (provider, model, task, token split, estimated
-- flag). usage_records.quantity carries the cost in micro-USD for `metric='llm'`
-- rows; meta carries the breakdown the FinOps/usage pages render.
ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS meta jsonb;
