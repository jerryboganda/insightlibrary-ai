-- Phase 6: ontology grounding + claim correlation support.
--
-- Adds the linked-concept column the correlation engine keys dedup/conflict on,
-- plus supporting indexes for (a) fast lexical alias lookup over the SHARED
-- concept synonyms and (b) dedup grouping by normalized meaning. Additive only:
-- no existing column/table is altered or dropped.

-- 1. Link a claim to its canonical ontology concept (e.g. the disease the claim
--    is about). SHARED concepts table has no tenant_id/RLS, so this is a plain
--    single-column FK (concepts are cross-tenant reference data). ON DELETE SET
--    NULL: dropping a concept must never cascade-delete a tenant's claim.
ALTER TABLE claims
    ADD COLUMN IF NOT EXISTS canonical_concept_id uuid
        REFERENCES concepts(id) ON DELETE SET NULL;

-- Dedup/conflict lookups filter tenant's claims by their linked concept.
CREATE INDEX IF NOT EXISTS idx_claims_tenant_concept
    ON claims (tenant_id, canonical_concept_id);

-- Dedup also groups by exact normalized_meaning within a tenant; this index
-- makes the "same normalized meaning" probe an indexed equality.
CREATE INDEX IF NOT EXISTS idx_claims_tenant_norm
    ON claims (tenant_id, normalized_meaning);

-- 2. GIN index over the SHARED concept synonyms so alias/exact lexical linking
--    (jsonb containment `synonyms_json @> '["addison disease"]'`) is indexed
--    rather than a full scan of the concept table on every mention.
CREATE INDEX IF NOT EXISTS idx_concepts_synonyms_gin
    ON concepts USING gin (synonyms_json jsonb_path_ops);

-- Lexical linking also probes pref_label case-insensitively; a functional index
-- on lower(pref_label) keeps that an indexed lookup. (ontology,code) already
-- UNIQUE, so no extra index needed for code lookups.
CREATE INDEX IF NOT EXISTS idx_concepts_lower_pref_label
    ON concepts (lower(pref_label));
