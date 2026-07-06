-- Credential sign-in happens BEFORE any tenant context exists (the client
-- only presents email + password), but `users` is RLS-protected by
-- tenant_id. Rather than weakening tenant isolation, add a second
-- PERMISSIVE policy that exposes exactly one email's rows to a transaction
-- that explicitly declares which email it is authenticating:
--
--   SELECT set_config('app.auth_email', '<email>', true);
--
-- The policy is SELECT-only; writes still require the tenant policy. When
-- app.auth_email is unset/empty it matches nothing (NULLIF → NULL, and
-- `email = NULL` is never true), so the fail-closed default is preserved.
CREATE POLICY auth_email_lookup ON users FOR SELECT
    USING (email = NULLIF(current_setting('app.auth_email', true), ''));

-- Password credentials are global (no tenant is known at sign-in), so an
-- email may back at most ONE password-auth user across all tenants. Emails
-- are stored lowercased by the app; the expression index also covers any
-- legacy mixed-case rows.
CREATE UNIQUE INDEX idx_users_password_email
    ON users (lower(email))
    WHERE password_hash IS NOT NULL;
