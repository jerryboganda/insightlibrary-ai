-- pgvector tables. Dense 768-dim text embeddings + optional sparse lexical
-- vectors for hybrid retrieval; 512-dim CLIP-style page image embeddings.
-- Composite (tenant_id, id) FKs onto tenant-scoped parents — see the
-- rationale note in 0002_documents.sql (FK checks bypass RLS).
CREATE TABLE chunks (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    vector            vector(768) NOT NULL,
    sparse            sparsevec,
    text              text NOT NULL,
    contextual_prefix text,
    block_id          uuid,
    topic             text,
    system_tags       jsonb,
    source_type       text,
    date              timestamptz,
    FOREIGN KEY (tenant_id, block_id)
        REFERENCES blocks (tenant_id, id) ON DELETE SET NULL (block_id)
);
CREATE INDEX idx_chunks_tenant ON chunks (tenant_id);
CREATE INDEX idx_chunks_block ON chunks (block_id);
CREATE INDEX idx_chunks_vector_hnsw ON chunks USING hnsw (vector vector_cosine_ops);

-- SHARED ontology embeddings: no tenant_id, no RLS.
CREATE TABLE concept_embeddings (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    vector     vector(768) NOT NULL,
    concept_id uuid REFERENCES concepts(id) ON DELETE CASCADE,
    ontology   text,
    label      text
);
CREATE INDEX idx_concept_embeddings_concept ON concept_embeddings (concept_id);
CREATE INDEX idx_concept_embeddings_vector_hnsw
    ON concept_embeddings USING hnsw (vector vector_cosine_ops);

CREATE TABLE page_images (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    vector    vector(512) NOT NULL,
    page_id   uuid,
    thumb_key text,
    FOREIGN KEY (tenant_id, page_id)
        REFERENCES pages (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_page_images_tenant ON page_images (tenant_id);
CREATE INDEX idx_page_images_page ON page_images (page_id);
