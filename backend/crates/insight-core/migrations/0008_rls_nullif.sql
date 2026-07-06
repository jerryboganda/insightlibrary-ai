-- Harden the tenant policies against the empty-string GUC state.
--
-- After a transaction that ran set_config('app.tenant', <uuid>, true)
-- commits, the custom GUC reverts to its session value — which for a
-- previously-unset custom GUC materializes as '' (empty string), NOT unset.
-- current_setting('app.tenant', true) then returns '' and ''::uuid raises
-- "invalid input syntax for type uuid" on every subsequent query on that
-- pooled connection. NULLIF maps '' back to NULL so a missing/cleared tenant
-- context cleanly yields zero rows (fail-closed, no error).
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
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I '
            'USING (tenant_id = NULLIF(current_setting(''app.tenant'', true), '''')::uuid) '
            'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant'', true), '''')::uuid)',
            t
        );
    END LOOP;
END
$$;
