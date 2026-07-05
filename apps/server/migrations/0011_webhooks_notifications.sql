-- 0011 — webhook delivery, notification archiving, per-stage pipeline timings,
-- review-conflict linkage, audit pagination index. Supports gaps:
--   B3  webhooks actually fire: per-endpoint HMAC secret + last delivery result
--       (written by lib/server/webhooks/dispatch.ts).
--   B29 per-item notification state: archived flag (POST /api/notifications/[id]/archive
--       and PATCH /api/notifications/[id] persist it; list excludes archived rows).
--   B16 real pipeline metrics: processing_jobs.stages jsonb accumulates a
--       first-seen timestamp per stage (written by jobs/processing-store.ts,
--       aggregated by GET /api/processing/stats).
--   B21 review resolution → claims: review_items carries the two conflicted
--       claim ids so approving/rejecting can supersede/restore the right rows
--       (written by refinery/conflict.ts, read by resolveClaimConflict).
--   B32 audit pagination: composite index for ORDER BY timestamp DESC pages.
-- ADDITIVE ONLY, idempotent. Runtime code tolerates these columns being absent
-- (raw-SQL fallbacks), so deploy order is safe either way.

-- ── B3: webhook secrets + delivery bookkeeping ───────────────────────────────
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS secret text;
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS last_delivery_at timestamp;
-- e.g. '200', '503', 'error: timeout' — text keeps transport errors representable.
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS last_status text;

-- ── B29: notification archiving (read already exists) ────────────────────────
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS notifications_org_created_idx ON notifications (org_id, created_at DESC);

-- ── B16: per-stage timestamps ({stage: first-seen timestamptz}) ──────────────
ALTER TABLE processing_jobs ADD COLUMN IF NOT EXISTS stages jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ── B21: conflicted-claim linkage on review items ─────────────────────────────
-- original_claim_id = the pre-existing claim, new_claim_id = the incoming one.
-- Legacy rows keep NULLs; resolution falls back to text+document matching.
ALTER TABLE review_items ADD COLUMN IF NOT EXISTS original_claim_id text;
ALTER TABLE review_items ADD COLUMN IF NOT EXISTS new_claim_id text;
ALTER TABLE review_items ADD COLUMN IF NOT EXISTS resolved_at timestamp;

-- ── B32: audit list pagination/date filters ──────────────────────────────────
CREATE INDEX IF NOT EXISTS audit_logs_org_ts_idx ON audit_logs (org_id, timestamp DESC);
