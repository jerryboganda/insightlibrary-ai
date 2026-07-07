-- Phase 11: research workspace projects + a tenant ontology registry. Additive.

-- Research projects: one of four builder types, with a single type-specific
-- `data` blob (matches the frontend ResearchProject shape).
CREATE TABLE research_projects (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    kind       text NOT NULL DEFAULT 'report'
                   CHECK (kind IN ('argument_map', 'compare_matrix', 'report', 'timeline')),
    title      text NOT NULL DEFAULT 'Untitled',
    data       jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_research_projects_tenant ON research_projects (tenant_id, kind);

-- MCQ publication status (draft/published) for the answer-key/draft gate.
ALTER TABLE mcqs ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published'));

-- Ontology registry: a tenant-visible catalog of loaded ontologies (the actual
-- concepts live in the SHARED concepts table). schema_json holds the entity
-- classes + properties the schema editor manages.
CREATE TABLE ontologies (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        text NOT NULL,
    description text,
    prefix      text,
    status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('active', 'draft')),
    schema_json jsonb NOT NULL DEFAULT '{"entities":[]}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ontologies_tenant ON ontologies (tenant_id);

-- RLS (0007's loop predates these). NULLIF-hardened tenant policy (0008 shape).
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['research_projects', 'ontologies']
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
