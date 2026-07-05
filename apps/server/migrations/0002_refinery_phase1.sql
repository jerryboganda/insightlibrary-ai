-- Phase 1 — ingestion & block model (ADDITIVE ONLY, idempotent).

-- Contextual-retrieval prefix + block anchor on chunks.
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS context text;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS block_id text;

-- Structure-aware parse output.
CREATE TABLE IF NOT EXISTS doc_pages (
	id text PRIMARY KEY,
	document_id text NOT NULL REFERENCES documents(id),
	page_no integer NOT NULL,
	width real,
	height real,
	status text NOT NULL DEFAULT 'parsed'
);
CREATE INDEX IF NOT EXISTS doc_pages_doc_idx ON doc_pages (document_id, page_no);

CREATE TABLE IF NOT EXISTS doc_blocks (
	id text PRIMARY KEY,
	document_id text NOT NULL REFERENCES documents(id),
	page_no integer NOT NULL,
	kind text NOT NULL DEFAULT 'text',
	bbox jsonb,
	reading_order integer NOT NULL DEFAULT 0,
	content text NOT NULL,
	chunk_id text,
	coverage_status text NOT NULL DEFAULT 'unaccounted',
	confidence real NOT NULL DEFAULT 0.6
);
CREATE INDEX IF NOT EXISTS doc_blocks_doc_idx ON doc_blocks (document_id, page_no, reading_order);
