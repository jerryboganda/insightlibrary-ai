-- Study engine: flashcards + FSRS schedules, MCQs + attempts, study plans.
-- card_schedules/quiz_attempts/study_plans carry an explicit tenant_id
-- (denormalized from the owning card/mcq/user) so RLS stays a simple
-- indexed equality check rather than an EXISTS through the parent.
-- All FKs onto tenant-scoped parents are composite (tenant_id, id) — see the
-- rationale note in 0002_documents.sql (FK checks bypass RLS).
CREATE TABLE flashcards (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    topic_id        uuid,
    front           text NOT NULL,
    back            text NOT NULL,
    source_claim_id uuid,
    UNIQUE (tenant_id, id),
    FOREIGN KEY (tenant_id, topic_id)
        REFERENCES topics (tenant_id, id) ON DELETE SET NULL (topic_id),
    FOREIGN KEY (tenant_id, source_claim_id)
        REFERENCES claims (tenant_id, id) ON DELETE SET NULL (source_claim_id)
);
CREATE INDEX idx_flashcards_topic ON flashcards (topic_id);

CREATE TABLE card_schedules (
    card_id         uuid NOT NULL,
    user_id         uuid NOT NULL,
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    fsrs_state_json jsonb,
    due_at          timestamptz,
    PRIMARY KEY (card_id, user_id),
    FOREIGN KEY (tenant_id, card_id)
        REFERENCES flashcards (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, user_id)
        REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_card_schedules_tenant ON card_schedules (tenant_id);
CREATE INDEX idx_card_schedules_user_due ON card_schedules (user_id, due_at);

CREATE TABLE mcqs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    topic_id        uuid,
    stem            text NOT NULL,
    options_json    jsonb NOT NULL,
    answer          text NOT NULL,
    rationale       text,
    difficulty      text,
    source_claim_id uuid,
    UNIQUE (tenant_id, id),
    FOREIGN KEY (tenant_id, topic_id)
        REFERENCES topics (tenant_id, id) ON DELETE SET NULL (topic_id),
    FOREIGN KEY (tenant_id, source_claim_id)
        REFERENCES claims (tenant_id, id) ON DELETE SET NULL (source_claim_id)
);
CREATE INDEX idx_mcqs_topic ON mcqs (topic_id);

CREATE TABLE quiz_attempts (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id      uuid NOT NULL,
    mcq_id       uuid NOT NULL,
    chosen       text NOT NULL,
    correct      bool NOT NULL,
    confidence   text,
    ms           int,
    attempted_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, user_id)
        REFERENCES users (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, mcq_id)
        REFERENCES mcqs (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_quiz_attempts_tenant ON quiz_attempts (tenant_id);
CREATE INDEX idx_quiz_attempts_user ON quiz_attempts (user_id);
CREATE INDEX idx_quiz_attempts_mcq ON quiz_attempts (mcq_id);

CREATE TABLE study_plans (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id       uuid NOT NULL,
    goal          text NOT NULL,
    exam_date     date,
    schedule_json jsonb,
    FOREIGN KEY (tenant_id, user_id)
        REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_study_plans_tenant ON study_plans (tenant_id);
CREATE INDEX idx_study_plans_user ON study_plans (user_id);
