-- Phase 4 ingestion writes chunk ROWS before embeddings exist (Phase 5 fills
-- them). The original chunks.vector is `vector(768) NOT NULL`, so P4 cannot
-- insert a chunk without a real embedding. Relax that: allow a NULL vector for
-- unembedded chunks and add an explicit `embedded` marker so Phase 5 has a
-- cheap, indexable predicate for the backfill worklist.
--
-- Additive + backfill-safe: existing rows all have a vector, so we flip them
-- to embedded = true; new P4 chunks land with vector NULL / embedded false.
ALTER TABLE chunks ALTER COLUMN vector DROP NOT NULL;
ALTER TABLE chunks ADD COLUMN embedded boolean NOT NULL DEFAULT false;

-- Everything already in the table carries a real 768-dim vector.
UPDATE chunks SET embedded = true WHERE vector IS NOT NULL;

-- Phase 5 pulls the backfill worklist off this partial index.
CREATE INDEX idx_chunks_unembedded ON chunks (tenant_id) WHERE NOT embedded;
