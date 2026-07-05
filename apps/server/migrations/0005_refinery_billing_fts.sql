-- Phase 5 (hosted tier) — billing + context-weighted FTS (ADDITIVE, idempotent).

CREATE TABLE IF NOT EXISTS billing (
	org_id text PRIMARY KEY REFERENCES organizations(id),
	stripe_customer_id text,
	stripe_subscription_id text,
	plan text NOT NULL DEFAULT 'free',
	status text NOT NULL DEFAULT 'inactive',
	current_period_end timestamp,
	updated_at timestamp NOT NULL DEFAULT now()
);

-- Context-weighted FTS expression index (contextual prefix weighted above body).
-- Additive: does not touch the existing content_fts generated column.
CREATE INDEX IF NOT EXISTS chunks_weighted_fts_idx ON chunks USING gin (
	(setweight(to_tsvector('english', coalesce(context, '')), 'A') ||
	 setweight(to_tsvector('english', content), 'B'))
);
