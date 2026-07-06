-- Claims, ontology concepts (shared, cross-tenant), topics, knowledge graph.
-- All child FKs onto tenant-scoped parents are composite (tenant_id, id) —
-- see the rationale note in 0002_documents.sql (FK checks bypass RLS).
CREATE TABLE claims (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    canonical_topic    text,
    claim_type         text NOT NULL DEFAULT 'fact',
    claim_text         text NOT NULL,
    normalized_meaning text,
    system_tags_json   jsonb,
    exam_tags_json     jsonb,
    confidence_json    jsonb,
    status             text NOT NULL DEFAULT 'pending',
    created_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id)
);
CREATE INDEX idx_claims_tenant_topic ON claims (tenant_id, canonical_topic);

-- claim_sources carries an explicit tenant_id (copied from the owning claim)
-- so RLS is a plain indexed equality instead of an EXISTS through claims.
-- ON DELETE SET NULL (block_id) nulls only the id column, never tenant_id
-- (column-list referential actions require PG 15+; we target PG 16).
CREATE TABLE claim_sources (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    claim_id    uuid NOT NULL,
    document_id uuid NOT NULL,
    block_id    uuid,
    FOREIGN KEY (tenant_id, claim_id)
        REFERENCES claims (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, document_id)
        REFERENCES documents (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, block_id)
        REFERENCES blocks (tenant_id, id) ON DELETE SET NULL (block_id)
);
CREATE INDEX idx_claim_sources_tenant ON claim_sources (tenant_id);
CREATE INDEX idx_claim_sources_claim ON claim_sources (claim_id);
CREATE INDEX idx_claim_sources_document ON claim_sources (document_id);

-- SHARED ontology reference data: deliberately no tenant_id and no RLS.
CREATE TABLE concepts (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ontology      text NOT NULL,
    code          text NOT NULL,
    pref_label    text NOT NULL,
    synonyms_json jsonb,
    UNIQUE (ontology, code)
);

-- SHARED, no RLS.
CREATE TABLE concept_edges (
    parent_id uuid NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
    child_id  uuid NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
    rel       text NOT NULL DEFAULT 'is_a',
    PRIMARY KEY (parent_id, child_id, rel)
);
CREATE INDEX idx_concept_edges_child ON concept_edges (child_id);

CREATE TABLE topics (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    canonical_concept_id uuid REFERENCES concepts(id) ON DELETE SET NULL,
    title                text NOT NULL,
    version              int NOT NULL DEFAULT 1,
    current_page_md      text,
    visibility           text NOT NULL DEFAULT 'private',
    updated_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id)
);
CREATE INDEX idx_topics_concept ON topics (canonical_concept_id);

-- Explicit tenant_id (copied from the owning topic) for a simple RLS policy.
CREATE TABLE topic_versions (
    topic_id      uuid NOT NULL,
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    version       int NOT NULL,
    page_md       text,
    changelog     text,
    source_doc_id uuid,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (topic_id, version),
    FOREIGN KEY (tenant_id, topic_id)
        REFERENCES topics (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, source_doc_id)
        REFERENCES documents (tenant_id, id) ON DELETE SET NULL (source_doc_id)
);
CREATE INDEX idx_topic_versions_tenant ON topic_versions (tenant_id);

CREATE TABLE nodes (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    kind                 text NOT NULL,
    label                text NOT NULL,
    canonical_concept_id uuid REFERENCES concepts(id) ON DELETE SET NULL,
    description          text,
    UNIQUE (tenant_id, id)
);
CREATE INDEX idx_nodes_tenant_label ON nodes (tenant_id, label);

CREATE TABLE edges (
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    src_id          uuid NOT NULL,
    dst_id          uuid NOT NULL,
    rel             text NOT NULL,
    weight          real NOT NULL DEFAULT 1.0,
    source_claim_id uuid,
    PRIMARY KEY (tenant_id, src_id, dst_id, rel),
    FOREIGN KEY (tenant_id, src_id)
        REFERENCES nodes (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, dst_id)
        REFERENCES nodes (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, source_claim_id)
        REFERENCES claims (tenant_id, id) ON DELETE SET NULL (source_claim_id)
);
CREATE INDEX idx_edges_src ON edges (src_id);
CREATE INDEX idx_edges_dst ON edges (dst_id);
