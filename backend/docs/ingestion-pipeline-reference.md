# Existing ingestion pipeline (P4 behavioral reference)

Inventoried 2026-07-07 from the live `insightlibrary/apps/server` Node backend. The new Rust
worker + Docling `parser-svc` should reproduce these contracts, and ADD what's missing
(real Docling structure, bounding boxes, page thumbnails, figure-crop extraction, OCR).

## Pipeline stages (progress % the UI expects)

queued → extract(0–10) → parse(10–28) → chunk(28–40) → contextualize(40–60) →
embed(60–85) → index(85–95) → claims/correlate/graph(95–100).
Progress event shape today: { documentId, documentTitle, stage, progress, message }.
Our P3 WS uses channel `user:{id}` with {type:"job", id, status, progress} — keep progress
0–100 and the stage vocabulary above so the FE maps cleanly.

## Canonical parsed structure to match (ParsedDoc)

BlockKind = text | heading | list | table | figure | caption.
ParsedBlock { kind, page (1-indexed), readingOrder (global), content, bbox?:[x1,y1,x2,y2]|null,
confidence (0.6 heuristic … 0.85 external) }.
ParsedPage { pageNo, width?, height? }.
ParsedDoc { pages[], blocks[], text (blocks joined \n\n) }.

Our P2 schema already has: pages(page_no,width,height,thumb_key,status),
blocks(kind,bbox jsonb,reading_order,text,table_json,figure_key,confidence,status). Map
ParsedBlock.content→blocks.text, tables→table_json (GFM markdown or json), figure crop key→figure_key,
page thumbnail key→pages.thumb_key.

## Coverage/status vocabulary

documents.status: processing | indexed | needs_review | failed.
pages.status: parsed (default) → indexed | skipped | low_confidence | needs_review.
blocks coverage (Node used doc_blocks.coverage_status): unaccounted → chunked → claimed;
plus ignored | low_confidence | needs_review. The master plan's Phase 4 wants coverage
accounting: parsed | indexed | skipped | low_confidence | needs_review — reconcile to the
blocks.status column, and track every block through to a terminal state so coverage is auditable.

## Chunking (match these defaults)

chunkText(text, target=800 chars, overlap=120), prefer sentence boundaries; block link id
pattern `{documentId}_p{pageNo}_b{readingOrder}`. Contextual prefix: 1 sentence ≤25 words
situating the chunk in the document (cap CONTEXTUAL_MAX_CHUNKS=150). Embeddings: 768-dim
(gemini today) → our chunks.vector is vector(768). Contextual prefix stored in
chunks.contextual_prefix.

## parser-svc design (P4, replaces unpdf/LlamaParse)

- FastAPI POST /parse (multipart file OR {storage_key}) → ParsedDoc JSON + per-page thumbnails
  (base64 or pushed to MinIO by the worker) + figure crops. Docling (MIT) is the primary parser;
  MinerU (AGPL) isolated in THIS container only for hard pages. Add OCR (tesseract/Docling OCR)
  for scanned PDFs — a current gap (unpdf fails silently on scans).
- Worker ingest job (apalis/Redis Streams): fetch bytes from MinIO (internal endpoint) → POST to
  parser-svc → persist pages/blocks (tenant-scoped tx) → upload thumbs/figures to MinIO
  (thumbs/{tenant}/{page_id}.webp, figures/{tenant}/{block_id}.png) → set coverage statuses →
  publish progress over WS. Retries/backoff/DLQ via apalis.

## Config knobs to carry forward

PARSE_MODE (heuristic|document-ai|external → for us: docling|docling+ocr|minio-hard),
PARSE_AI_MAX_PAGES=20, CONTEXTUAL_MAX_CHUNKS=150, org-settings overrides (parseMode etc.).
Gaps the new system closes: Docling structure, bboxes on all modes, image/figure extraction to
MinIO, OCR for scans, multi-page figures.
