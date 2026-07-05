-- Phase 7 — eval harness (ADDITIVE ONLY, idempotent).
CREATE TABLE IF NOT EXISTS eval_runs (
	id text PRIMARY KEY,
	org_id text NOT NULL REFERENCES organizations(id),
	faithfulness real NOT NULL DEFAULT 0,
	citation_accuracy real NOT NULL DEFAULT 0,
	hallucination_rate real NOT NULL DEFAULT 0,
	novelty_precision real NOT NULL DEFAULT 0,
	recent_tests jsonb NOT NULL DEFAULT '[]'::jsonb,
	created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eval_runs_org_created_idx ON eval_runs (org_id, created_at DESC);
