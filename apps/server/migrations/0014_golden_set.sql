-- 0014 — golden_items: admin-manageable golden evaluation set (gap C8).
--
-- Replaces the fixed bundled file (eval/golden/medical-v1.jsonl) as the source
-- of truth for evaluation runs. lib/server/eval/golden-store.ts seeds this table
-- per-org from the bundled file on first read (idempotent), then runGoldenEval
-- and the admin management UI (/api/evaluation/golden) read/write it. The
-- bundled file remains the fallback when this table is empty or absent, so
-- deploy order is safe and nothing regresses.
--
-- No FK on org_id: like usage_events, rows must survive orgs that exist in
-- better-auth but are not yet mirrored into the app organizations table (C10).
-- ADDITIVE ONLY, idempotent.

CREATE TABLE IF NOT EXISTS golden_items (
	id text PRIMARY KEY,
	org_id text NOT NULL,
	query text NOT NULL,
	expect text NOT NULL,
	-- 'seed' (copied from the bundled set) | 'custom' (admin-authored).
	source text NOT NULL DEFAULT 'custom',
	created_at timestamp NOT NULL DEFAULT now(),
	updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS golden_items_org_created_idx ON golden_items (org_id, created_at);
