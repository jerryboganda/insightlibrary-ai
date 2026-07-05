-- 0010 — usage_events: per-call AI usage ledger (metering, gap B17) powering
-- GET /api/usage aggregation and the router's budget enforcement (gap C6).
-- Written fire-and-forget by lib/server/usage/metering.ts from the provider
-- router and embedText. No FK on org_id: rows must survive orgs that exist in
-- better-auth but are not yet mirrored into the app organizations table (C10),
-- and a metering insert must never fail an AI call.
-- ADDITIVE ONLY, idempotent.

CREATE TABLE IF NOT EXISTS usage_events (
	id text PRIMARY KEY,
	org_id text NOT NULL,
	user_id text,
	provider text NOT NULL,
	model text NOT NULL DEFAULT '',
	task text NOT NULL DEFAULT 'chat',
	tokens_in integer NOT NULL DEFAULT 0,
	tokens_out integer NOT NULL DEFAULT 0,
	cost_usd double precision NOT NULL DEFAULT 0,
	duration_ms integer NOT NULL DEFAULT 0,
	created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS usage_events_org_created_idx ON usage_events (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS usage_events_org_task_idx ON usage_events (org_id, task);
