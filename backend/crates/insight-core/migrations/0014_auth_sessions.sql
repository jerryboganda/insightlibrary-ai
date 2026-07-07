-- Phase 7: identity plane — persistent sessions (for the settings "devices"
-- list + admin session revocation), org invitations, and two new user status
-- columns. Additive only.

-- 1. User status + platform role.
--    status: 'active' | 'suspended' (admin can suspend a member).
--    platform_role: 'user' | 'super_admin' — the cross-tenant operator role
--    that gates /api/admin/system-settings and the org console. Distinct from
--    the per-org role (owner/admin/editor/viewer) carried in the JWT.
ALTER TABLE users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_role text NOT NULL DEFAULT 'user'
    CHECK (platform_role IN ('user', 'super_admin'));

-- 2. Persistent auth sessions. id = the session id (`sid`) carried in the JWT;
--    stable across refresh rotations. current_jti tracks the currently-valid
--    refresh jti (rotated on each refresh) so revoking a session can also drop
--    its live refresh token from the Redis allowlist. The Redis allowlist stays
--    the fast per-request check; this table is the durable list/audit view.
CREATE TABLE auth_sessions (
    id           uuid PRIMARY KEY,
    tenant_id    uuid NOT NULL,
    user_id      uuid NOT NULL,
    current_jti  uuid NOT NULL,
    user_agent   text,
    ip_address   text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    revoked_at   timestamptz,
    FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions (tenant_id, user_id);

-- 3. Org invitations. Tokenless + email-keyed (ported from the Node contract):
--    the invite URL is `{base}/login?email=...` with NO token; signing up with
--    the invited email redeems the newest pending invite for that email. An
--    admin lists/creates/cancels invitations within their tenant.
CREATE TABLE invitations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email       text NOT NULL,
    role        text NOT NULL DEFAULT 'viewer',
    status      text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'accepted', 'canceled')),
    invited_by  uuid,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    accepted_at timestamptz
);
-- At most one live pending invite per (tenant, email) — invite refreshes it.
CREATE UNIQUE INDEX idx_invitations_pending
    ON invitations (tenant_id, lower(email))
    WHERE status = 'pending';

-- RLS for the two new tenant-scoped tables (0007's loop predates them). Same
-- NULLIF-hardened tenant policy as migration 0008.
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['auth_sessions', 'invitations']
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

-- Invite redemption happens BEFORE any tenant context exists (the signing-up
-- user only presents their email). Mirror the auth_email_lookup pattern from
-- migration 0009: a SELECT-only policy exposing exactly the pending invitations
-- for the declared email. The transaction sets:
--   SELECT set_config('app.invite_email', '<email>', true);
-- Fail-closed when unset (NULLIF('' ) -> NULL, `email = NULL` never true).
CREATE POLICY invite_email_lookup ON invitations FOR SELECT
    USING (status = 'pending'
           AND email = NULLIF(current_setting('app.invite_email', true), ''));
