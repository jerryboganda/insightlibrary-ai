-- Collaboration, sharing, cohorts, jobs, review queue, analytics, billing, keys.
-- User references are same-tenant by design here, so they use composite
-- (tenant_id, user_id) FKs — see the rationale note in 0002_documents.sql
-- (FK checks bypass RLS). Cross-tenant membership lives ONLY in memberships.
CREATE TABLE comments (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    target_kind text NOT NULL,
    target_id   uuid NOT NULL,
    user_id     uuid,
    body        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, user_id)
        REFERENCES users (tenant_id, id) ON DELETE SET NULL (user_id)
);
CREATE INDEX idx_comments_target ON comments (tenant_id, target_kind, target_id);

-- Spec's shares table is tenant-scoped: explicit tenant_id added for RLS.
CREATE TABLE shares (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    resource_kind text NOT NULL,
    resource_id   uuid NOT NULL,
    scope         text NOT NULL DEFAULT 'link',
    token         text NOT NULL UNIQUE,
    expires_at    timestamptz,
    created_by    uuid,
    FOREIGN KEY (tenant_id, created_by)
        REFERENCES users (tenant_id, id) ON DELETE SET NULL (created_by)
);
CREATE INDEX idx_shares_tenant ON shares (tenant_id);

CREATE TABLE cohorts (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name          text NOT NULL,
    instructor_id uuid,
    UNIQUE (tenant_id, id),
    FOREIGN KEY (tenant_id, instructor_id)
        REFERENCES users (tenant_id, id) ON DELETE SET NULL (instructor_id)
);

-- Explicit tenant_id (copied from the owning cohort) for a simple RLS policy.
CREATE TABLE cohort_assignments (
    cohort_id     uuid NOT NULL,
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id       uuid NOT NULL,
    resource_kind text NOT NULL,
    resource_id   uuid NOT NULL,
    due_at        timestamptz,
    PRIMARY KEY (cohort_id, user_id, resource_kind, resource_id),
    FOREIGN KEY (tenant_id, cohort_id)
        REFERENCES cohorts (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, user_id)
        REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_cohort_assignments_tenant ON cohort_assignments (tenant_id);
CREATE INDEX idx_cohort_assignments_user ON cohort_assignments (user_id);

CREATE TABLE jobs (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    kind         text NOT NULL,
    payload_json jsonb,
    status       text NOT NULL DEFAULT 'queued',
    attempts     int NOT NULL DEFAULT 0,
    last_error   text,
    progress     int NOT NULL DEFAULT 0,
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_jobs_tenant ON jobs (tenant_id);
CREATE INDEX idx_jobs_tenant_status ON jobs (tenant_id, status);

CREATE TABLE review_queue (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    ref_kind  text NOT NULL,
    ref_id    uuid NOT NULL,
    reason    text,
    status    text NOT NULL DEFAULT 'open'
);
CREATE INDEX idx_review_queue_tenant ON review_queue (tenant_id);
CREATE INDEX idx_review_queue_tenant_status ON review_queue (tenant_id, status);

CREATE TABLE events (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id    uuid,
    kind       text NOT NULL,
    props_json jsonb,
    ts         timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, user_id)
        REFERENCES users (tenant_id, id) ON DELETE SET NULL (user_id)
);
CREATE INDEX idx_events_tenant_ts ON events (tenant_id, ts);

CREATE TABLE usage_records (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    metric    text NOT NULL,
    quantity  bigint NOT NULL,
    ts        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_usage_records_tenant_metric ON usage_records (tenant_id, metric, ts);

CREATE TABLE api_keys (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    hash        text NOT NULL UNIQUE,
    scopes_json jsonb,
    revoked     bool NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_api_keys_tenant ON api_keys (tenant_id);

CREATE TABLE user_provider_keys (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider   text NOT NULL,
    ciphertext bytea NOT NULL
);
CREATE INDEX idx_user_provider_keys_tenant ON user_provider_keys (tenant_id);
