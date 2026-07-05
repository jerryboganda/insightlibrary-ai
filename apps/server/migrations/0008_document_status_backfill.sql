-- 0008 — document status backfill (gap B9) + cancellation support (gap B22).
-- The ingestion pipeline historically never advanced documents.status, so every
-- document stayed 'processing' forever. The pipeline now writes
-- 'indexed'/'failed'; this migration repairs the rows ingested before the fix,
-- deriving the outcome from existing evidence (chunks present / processing job
-- completed or failed). Also adds processing_jobs.boss_job_id so the cancel
-- endpoint can boss.cancel() jobs still sitting in the pg-boss queue.
-- ADDITIVE ONLY, idempotent.

-- B22: remember the pg-boss job id per processing job (written on enqueue).
ALTER TABLE processing_jobs ADD COLUMN IF NOT EXISTS boss_job_id text;

-- B9: refresh page counts from parse output where the document row was never
-- updated (pages defaulted to 0 at upload time).
UPDATE documents d
SET pages = sub.page_count
FROM (
	SELECT document_id, COUNT(*)::int AS page_count
	FROM doc_pages
	GROUP BY document_id
) sub
WHERE sub.document_id = d.id
  AND d.pages = 0
  AND sub.page_count > 0;

-- B9: documents whose pipeline demonstrably completed → 'indexed'.
-- Evidence: indexed chunks exist, or the processing job reached stage 'done'
-- (covers metadata-only documents that produce no chunks).
UPDATE documents d
SET status = 'indexed',
    status_label = 'Indexed'
WHERE d.status = 'processing'
  AND (
	EXISTS (SELECT 1 FROM chunks c WHERE c.document_id = d.id)
	OR EXISTS (
		SELECT 1 FROM processing_jobs pj
		WHERE pj.document_id = d.id AND pj.stage = 'done'
	)
  );

-- B9: remaining 'processing' documents whose job ended in 'failed'
-- (pipeline error or user cancellation) → 'failed'. Documents with a job
-- genuinely mid-stage are left as 'processing' (retry/cancel now work).
UPDATE documents d
SET status = 'failed',
    status_label = 'Processing failed'
WHERE d.status = 'processing'
  AND EXISTS (
	SELECT 1 FROM processing_jobs pj
	WHERE pj.document_id = d.id AND pj.stage = 'failed'
  );
