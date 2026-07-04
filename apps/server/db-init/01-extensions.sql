-- Runs once on first Postgres container start (docker-entrypoint-initdb.d).
-- pgvector powers semantic search; pg_trgm improves FTS typo tolerance.
-- Must exist before `drizzle-kit push` creates the vector column.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
