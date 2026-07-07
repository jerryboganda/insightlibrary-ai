-- Phase 7: the settings foundation — three scopes of runtime-tunable config,
-- each a single JSONB "overrides" blob resolved against code/env defaults and
-- clamped on read (see insight-core/src/settings.rs). Storing only the
-- overridden keys (sparse) keeps defaults live: bumping a default in code moves
-- every org that never set that key, exactly like the Node org-settings.ts the
-- behavior is ported from.

-- 1. System scope: ONE global row (super-admin only). Not tenant-scoped, so no
--    RLS — access is gated at the app layer by RequireSuperAdmin. The id=1
--    CHECK makes the singleton a schema invariant.
CREATE TABLE system_settings (
    id         smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    values     jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid
);
INSERT INTO system_settings (id, values) VALUES (1, '{}'::jsonb)
    ON CONFLICT (id) DO NOTHING;

-- 2. Org scope: one row per tenant. Carries the workspace identity (name/logo)
--    alongside the settings blob so the admin "general" page reads/writes both
--    in one round trip (mirrors Node's org_settings row shape).
CREATE TABLE org_settings (
    tenant_id  uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    name       text,
    logo_key   text,
    values     jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- 3. User scope: per-user UI preferences, scoped within a tenant. Composite FK
--    (tenant_id, user_id) -> users (tenant_id, id) so tenant agreement is part
--    of referential integrity (see the 0001 note on composite FKs).
CREATE TABLE user_preferences (
    user_id    uuid NOT NULL,
    tenant_id  uuid NOT NULL,
    values     jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, tenant_id),
    FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);

-- RLS for the two tenant-scoped tables (0007's loop predates them). Same
-- NULLIF-hardened policy shape as migration 0008.
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['org_settings', 'user_preferences']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I '
            'USING (tenant_id = NULLIF(current_setting(''app.tenant'', true), '''')::uuid) '
            'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant'', true), '''')::uuid)',
            t
        );
    END LOOP;
END
$$;
