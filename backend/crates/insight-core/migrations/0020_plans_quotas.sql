-- Phase 13: plan/quota catalog + per-tenant billing state + suspension.
-- Additive. `tenants.plan` (from 0001) references plans.id by convention.

CREATE TABLE plans (
    id              text PRIMARY KEY,
    name            text NOT NULL,
    seats           int NOT NULL DEFAULT 0,            -- 0 = unlimited
    document_cap    int NOT NULL DEFAULT 0,            -- 0 = unlimited
    ai_budget_usd   double precision NOT NULL DEFAULT 0, -- 0 = unlimited
    stripe_price_id text,
    features        jsonb NOT NULL DEFAULT '[]'::jsonb,
    active          boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO plans (id, name, seats, document_cap, ai_budget_usd, features) VALUES
    ('free', 'Free',  3,   100,  10,  '["Core ingest", "Hybrid search", "Copilot"]'::jsonb),
    ('pro',  'Pro',   25,  5000, 500, '["Everything in Free", "Priority processing", "Webhooks", "Higher budgets"]'::jsonb)
    ON CONFLICT (id) DO NOTHING;

-- Per-tenant billing state (tenants is the tenancy root — no RLS).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stripe_customer_id text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stripe_subscription_id text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan_status text NOT NULL DEFAULT 'active';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS suspended boolean NOT NULL DEFAULT false;
