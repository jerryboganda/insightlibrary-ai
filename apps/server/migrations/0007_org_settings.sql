-- 0007 — org_settings: per-org admin-manageable configuration (workspace
-- identity + governance/refinery/pipeline/search overrides as a JSONB overlay
-- over env defaults). Read/written only by lib/server/org-settings.ts.
-- ADDITIVE ONLY, idempotent.

CREATE TABLE IF NOT EXISTS org_settings (
	org_id text PRIMARY KEY REFERENCES organizations(id),
	name text,
	logo_key text,
	settings jsonb NOT NULL DEFAULT '{}'::jsonb,
	updated_at timestamp NOT NULL DEFAULT now()
);
