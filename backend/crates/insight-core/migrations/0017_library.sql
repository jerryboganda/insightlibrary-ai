-- Phase 9: library organization — folders and the source registry. Both use
-- TEXT primary keys because the frontend treats ids as opaque strings and
-- documents.folder_id is already text (migration 0010). Additive only.

-- Folders group documents. `docs`/`topics`/`health` in the API are derived at
-- read time (counts + indexed ratio), not stored.
CREATE TABLE folders (
    id         text PRIMARY KEY DEFAULT ('fld_' || replace(gen_random_uuid()::text, '-', '')),
    tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name       text NOT NULL,
    parent_id  text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_folders_tenant ON folders (tenant_id);

-- Source registry: named sources with a conflict-resolution priority (1 =
-- highest). `date` is a free-form publication date string in the API.
CREATE TABLE sources (
    id          text PRIMARY KEY DEFAULT ('src_' || replace(gen_random_uuid()::text, '-', '')),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        text NOT NULL,
    author      text NOT NULL DEFAULT '',
    source_type text NOT NULL DEFAULT 'document',
    priority    int NOT NULL DEFAULT 1,
    source_date text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sources_tenant ON sources (tenant_id);

-- RLS (0007's loop predates these). NULLIF-hardened tenant policy (0008 shape).
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['folders', 'sources']
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
