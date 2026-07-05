-- 0009 — mcq_attempts: server-side MCQ grading + attempt tracking (gap B13).
-- Every answered question is recorded here; the list endpoint stops shipping
-- correct answers to learners and the attempt endpoint grades server-side.
-- topic_id is denormalized from mcqs for cheap per-topic accuracy rollups
-- (Weakness tab / study mastery). user_id is nullable: better-auth user ids
-- are not FK-constrained to the app users table, and dev-bypass/API-key
-- principals still produce attempts.
-- ADDITIVE ONLY, idempotent.

CREATE TABLE IF NOT EXISTS mcq_attempts (
	id text PRIMARY KEY,
	org_id text NOT NULL REFERENCES organizations(id),
	mcq_id text NOT NULL REFERENCES mcqs(id),
	topic_id text NOT NULL REFERENCES topics(id),
	user_id text,
	chosen_option_id text NOT NULL,
	correct boolean NOT NULL,
	created_at timestamp NOT NULL DEFAULT now()
);

-- Per-topic accuracy rollups (stats in GET /api/mcqs?topicId=…).
CREATE INDEX IF NOT EXISTS mcq_attempts_topic_idx ON mcq_attempts (topic_id);
-- Per-question stats (attempt endpoint response).
CREATE INDEX IF NOT EXISTS mcq_attempts_mcq_idx ON mcq_attempts (mcq_id);
-- Per-learner scoping of the rollups.
CREATE INDEX IF NOT EXISTS mcq_attempts_user_idx ON mcq_attempts (user_id);
