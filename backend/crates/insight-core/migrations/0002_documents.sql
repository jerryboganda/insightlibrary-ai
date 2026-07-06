-- Documents and their parsed structure. Bytes live in MinIO; Postgres stores
-- object keys only (storage_key, thumb_key, figure_key).
--
-- Tenant-safety of foreign keys: FK constraint checks BYPASS row-level
-- security, so child tables reference their parents through composite
-- (tenant_id, parent_id) foreign keys against the parent's UNIQUE
-- (tenant_id, id). This makes it impossible to attach a row to another
-- tenant's parent (no cross-tenant existence oracle, no cross-tenant
-- CASCADE/SET NULL coupling) and guarantees the denormalized tenant_id can
-- never disagree with the parent's tenant_id.
CREATE TABLE documents (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    storage_key text NOT NULL,
    sha256      text NOT NULL,
    title       text NOT NULL,
    source_type text NOT NULL DEFAULT 'upload',
    source_ref  text,
    license     text,
    owner       text,
    course      text,
    subject     text,
    status      text NOT NULL DEFAULT 'pending',
    added_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id)
);
-- No plain (tenant_id) index: UNIQUE (tenant_id, id) already serves it.
CREATE INDEX idx_documents_tenant_status ON documents (tenant_id, status);
CREATE INDEX idx_documents_tenant_sha ON documents (tenant_id, sha256);

-- pages/blocks carry an explicit denormalized tenant_id (copied from the
-- owning document) so the RLS policy is a simple, fast, indexable equality
-- check instead of an EXISTS subquery through the parent on every row. The
-- composite FK enforces that the copy is correct.
CREATE TABLE pages (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    document_id uuid NOT NULL,
    page_no     int NOT NULL,
    width       real,
    height      real,
    thumb_key   text,
    status      text NOT NULL DEFAULT 'pending',
    UNIQUE (document_id, page_no),
    UNIQUE (tenant_id, id),
    FOREIGN KEY (tenant_id, document_id)
        REFERENCES documents (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_pages_document ON pages (document_id);

CREATE TABLE blocks (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    page_id       uuid NOT NULL,
    kind          text NOT NULL,
    bbox          jsonb,
    reading_order int,
    text          text,
    table_json    jsonb,
    figure_key    text,
    confidence    real,
    status        text NOT NULL DEFAULT 'pending',
    UNIQUE (tenant_id, id),
    FOREIGN KEY (tenant_id, page_id)
        REFERENCES pages (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_blocks_page ON blocks (page_id);
