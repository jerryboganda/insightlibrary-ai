-- Phase 12 (deferred): X-Api-Key REQUEST authentication.
--
-- `api_keys` is tenant-scoped and RLS-protected, so a request presenting a raw
-- key cannot be resolved to its tenant before the tenant is known (the RLS
-- `app.tenant` GUC isn't set yet on an unauthenticated request). This adds a
-- NON-RLS lookup table keyed by the secret's SHA-256 hash -- read only by the
-- exact hash, so it needs no tenant policy (same class as `plans` and the
-- pre-auth email-lookup paths) -- plus a per-key `role` column for
-- authorization. Additive.

-- Per-key authorization role (owner/admin/editor/viewer). Keys default to
-- `editor`: content read/write, never user/billing/platform admin.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'editor';

-- Secret-hash -> tenant/role lookup. NO RLS: it is only ever read by the exact
-- secret hash (an unguessable 128-bit token), never enumerated, and it must be
-- readable before any tenant context exists.
CREATE TABLE IF NOT EXISTS api_key_auth (
    hash       text PRIMARY KEY,
    key_id     uuid NOT NULL,
    tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    role       text NOT NULL DEFAULT 'editor',
    revoked    boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_api_key_auth_key ON api_key_auth (key_id);

-- Backfill keys minted before this migration. `api_keys` is FORCE RLS, so an
-- owner-run SELECT is filtered to nothing without the tenant GUC; drop FORCE
-- for the copy, then restore it. (A superuser migration role bypasses RLS
-- anyway, so this is a no-op there and correct for a non-superuser owner.)
ALTER TABLE api_keys NO FORCE ROW LEVEL SECURITY;
INSERT INTO api_key_auth (hash, key_id, tenant_id, role, revoked)
    SELECT hash, id, tenant_id, role, revoked FROM api_keys
    ON CONFLICT (hash) DO NOTHING;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
