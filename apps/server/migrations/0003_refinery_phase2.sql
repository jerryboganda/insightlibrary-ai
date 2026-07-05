-- Phase 2 — ontology grounding (ADDITIVE ONLY, idempotent).

CREATE TABLE IF NOT EXISTS concepts (
	id text PRIMARY KEY,
	ontology text NOT NULL,
	code text NOT NULL,
	pref_label text NOT NULL,
	kind text NOT NULL DEFAULT 'concept',
	description text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS concepts_ontology_idx ON concepts (ontology);
CREATE INDEX IF NOT EXISTS concepts_pref_label_lower_idx ON concepts (lower(pref_label));

CREATE TABLE IF NOT EXISTS concept_synonyms (
	id text PRIMARY KEY,
	concept_id text NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
	synonym text NOT NULL,
	source text NOT NULL DEFAULT 'ontology'
);
CREATE INDEX IF NOT EXISTS concept_synonyms_concept_idx ON concept_synonyms (concept_id);
CREATE INDEX IF NOT EXISTS concept_synonyms_lower_idx ON concept_synonyms (lower(synonym));

CREATE TABLE IF NOT EXISTS concept_edges (
	id text PRIMARY KEY,
	source_concept_id text NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
	target_concept_id text NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
	rel text NOT NULL DEFAULT 'is_a',
	weight real NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS concept_edges_source_idx ON concept_edges (source_concept_id);

CREATE TABLE IF NOT EXISTS concept_embeddings (
	id text PRIMARY KEY,
	concept_id text NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
	label text NOT NULL,
	embedding vector(768)
);
CREATE INDEX IF NOT EXISTS concept_embeddings_hnsw ON concept_embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS concept_embeddings_concept_idx ON concept_embeddings (concept_id);
