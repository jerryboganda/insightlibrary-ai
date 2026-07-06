-- Extensions: pgvector for embeddings; pgcrypto for gen_random_uuid()
-- (built into PG13+ core, but kept for portability to older images).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Tenancy root. Not tenant-scoped itself (a row IS the tenant), so no RLS:
-- tenant creation/signup must happen before any tenant context exists.
CREATE TABLE tenants (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind       text NOT NULL CHECK (kind IN ('user', 'org')),
    name       text NOT NULL,
    plan       text NOT NULL DEFAULT 'free',
    created_at timestamptz NOT NULL DEFAULT now()
);

-- UNIQUE (tenant_id, id) on every RLS parent table lets child tables use
-- composite foreign keys of the form (tenant_id, parent_id) REFERENCES
-- parent (tenant_id, id). FK checks bypass RLS in PostgreSQL, so a
-- single-column FK would let a session with tenant A context attach a child
-- row to tenant B's parent (existence oracle + cross-tenant CASCADE/SET NULL
-- coupling + silent tenant_id divergence). The composite form makes tenant
-- agreement part of referential integrity itself.
CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email         text NOT NULL,
    name          text,
    role          text NOT NULL DEFAULT 'member',
    auth_subject  text,
    password_hash text,
    locale        text NOT NULL DEFAULT 'en',
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, email),
    UNIQUE (tenant_id, id)
);

-- memberships.user_id stays a single-column FK ON PURPOSE: a membership links
-- a user (whose home tenant is users.tenant_id) to a possibly DIFFERENT
-- tenant (memberships.tenant_id is the org being joined), so tenant agreement
-- must not be enforced here.
CREATE TABLE memberships (
    user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    role      text NOT NULL DEFAULT 'member',
    PRIMARY KEY (user_id, tenant_id)
);
CREATE INDEX idx_memberships_tenant ON memberships (tenant_id);

CREATE TABLE workspaces (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name       text NOT NULL,
    visibility text NOT NULL DEFAULT 'private'
);
CREATE INDEX idx_workspaces_tenant ON workspaces (tenant_id);
