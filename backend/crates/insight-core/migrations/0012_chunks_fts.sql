-- Phase 5 hybrid retrieval: add a Postgres full-text-search vector over each
-- chunk's lexical content so FTS candidates can be fused (via RRF) with dense
-- pgvector KNN. This is the local, key-free lexical leg of hybrid retrieval —
-- it works with no paid API and no inference-svc round-trip.
--
-- The tsvector is a STORED GENERATED column: Postgres maintains it
-- automatically on every insert/update of text/contextual_prefix, so the
-- ingest path (which inserts chunks with contextual_prefix NULL, then Phase 5
-- fills it) never has to touch it. contextual_prefix is weighted 'B' (a short
-- situating sentence) and the chunk body 'A' so body terms dominate ranking.
--
-- Additive + backfill-safe: the generated column is computed for every
-- existing row at ALTER time; a partial-free GIN index accelerates
-- websearch_to_tsquery lookups. Uses 'english' config to match the corpus.
ALTER TABLE chunks
    ADD COLUMN fts tsvector
    GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(text, '')), 'A')
        || setweight(to_tsvector('english', coalesce(contextual_prefix, '')), 'B')
    ) STORED;

CREATE INDEX idx_chunks_fts ON chunks USING gin (fts);
