-- Row-level security for every tenant-scoped table.
--
-- All tenant tables carry an explicit tenant_id column (denormalized onto
-- child tables like pages/blocks/claim_sources/topic_versions/card_schedules/
-- quiz_attempts/cohort_assignments/study_plans — see comments in earlier
-- migrations), so a single simple policy shape works everywhere.
--
-- FORCE ROW LEVEL SECURITY makes the policies apply even to the table owner —
-- but ONLY for non-superuser owners. A SUPERUSER (or a role with BYPASSRLS)
-- ignores RLS entirely, FORCE or not. The bootstrap POSTGRES_USER of the
-- official postgres/pgvector image IS a superuser, so the app must NEVER
-- connect as it: the compose stack provisions a dedicated non-superuser
-- login role (deploy/postgres-init/01-app-role.sh, default `insight_app`)
-- that owns the database, and DATABASE_URL points at that role. FORCE then
-- binds that owner. Stores::connect and the selftest both fail fast if the
-- connected role is SUPERUSER or BYPASSRLS.
--
-- The tenant context is set per-transaction via
--   SELECT set_config('app.tenant', '<uuid>', true);
-- current_setting('app.tenant', true) returns NULL when unset, so a session
-- with no tenant context sees (and can write) nothing.
--
-- Shared reference tables (tenants, concepts, concept_edges,
-- concept_embeddings) deliberately have NO RLS.
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'users', 'memberships', 'workspaces',
        'documents', 'pages', 'blocks',
        'claims', 'claim_sources', 'topics', 'topic_versions',
        'nodes', 'edges',
        'flashcards', 'card_schedules', 'mcqs', 'quiz_attempts', 'study_plans',
        'comments', 'shares', 'cohorts', 'cohort_assignments',
        'jobs', 'review_queue', 'events', 'usage_records',
        'api_keys', 'user_provider_keys',
        'chunks', 'page_images'
    ]
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I '
            'USING (tenant_id = current_setting(''app.tenant'', true)::uuid) '
            'WITH CHECK (tenant_id = current_setting(''app.tenant'', true)::uuid)',
            t
        );
    END LOOP;
END
$$;
