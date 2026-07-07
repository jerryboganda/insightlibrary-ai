-- Phase 12: ops plane — notifications, webhooks, audit log, evaluation golden
-- set + runs. Additive. api_keys (from 0005) gains display columns.

CREATE TABLE notifications (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    kind        text NOT NULL DEFAULT 'alert'
                    CHECK (kind IN ('ssot_merge', 'conflict', 'novelty', 'alert')),
    title       text NOT NULL,
    description text NOT NULL DEFAULT '',
    action      text,
    read        boolean NOT NULL DEFAULT false,
    archived    boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_tenant ON notifications (tenant_id, created_at DESC);

CREATE TABLE webhooks (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    url              text NOT NULL,
    event            text NOT NULL DEFAULT '*',
    active           boolean NOT NULL DEFAULT true,
    secret           text,
    last_delivery_at timestamptz,
    last_status      text,
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_webhooks_tenant ON webhooks (tenant_id);

CREATE TABLE audit_logs (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    actor      text NOT NULL DEFAULT '',
    action     text NOT NULL,
    target     text NOT NULL DEFAULT '',
    severity   text NOT NULL DEFAULT 'info'
                   CHECK (severity IN ('info', 'warning', 'critical')),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_logs_tenant ON audit_logs (tenant_id, created_at DESC);

CREATE TABLE golden_items (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    query      text NOT NULL,
    expect     text NOT NULL,
    source     text NOT NULL DEFAULT 'custom' CHECK (source IN ('seed', 'custom')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_golden_items_tenant ON golden_items (tenant_id);

CREATE TABLE eval_runs (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    faithfulness       double precision NOT NULL DEFAULT 0,
    citation_accuracy  double precision NOT NULL DEFAULT 0,
    hallucination_rate double precision NOT NULL DEFAULT 0,
    novelty_precision  double precision NOT NULL DEFAULT 0,
    created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_eval_runs_tenant ON eval_runs (tenant_id, created_at DESC);

-- api_keys display columns (the plaintext is never stored; hash lives in 0005).
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT 'API Key';
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_hint text NOT NULL DEFAULT '';
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS last_used_at timestamptz;

-- RLS for the new tenant tables (NULLIF-hardened, per 0008).
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['notifications', 'webhooks', 'audit_logs', 'golden_items', 'eval_runs']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I '
            'USING (tenant_id = NULLIF(current_setting(''app.tenant'', true), '''')::uuid) '
            'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant'', true), '''')::uuid)',
            t
        );
    END LOOP;
END
$$;
