//! Ingestion pipeline (Phase 4): document registration, parser-svc
//! orchestration, pages/blocks persistence, coverage accounting.
//!
//! [`run_ingest`] is the worker entry point for `kind == "ingest"` jobs. It
//! pulls the uploaded bytes from MinIO, POSTs them to the Docling `parser-svc`,
//! and persists the returned [`ParsedDoc`] (pages, blocks, chunks, thumbnails,
//! figure crops) in ONE tenant-scoped transaction. Progress is published over
//! the WS fan-out at the stages the FE expects:
//! `extract(10) → parse(28) → chunk(40) → contextualize(60) → embed(85) →
//! index(95) → done(100)`. Contextualize/embed are no-ops in Phase 4 (Phase 5
//! fills embeddings by backfilling the `embedded = false` chunks).
//!
//! On any parser/IO error the document is flipped to `failed`, a `failed`
//! progress event is published, and an `Err` is returned. The worker always
//! XACKs, so a failure never poisons the queue.

use anyhow::Context;
use base64::Engine;
use serde::Deserialize;
use uuid::Uuid;

use crate::retrieve;
use crate::storage::queue::JobQueue;
use crate::storage::{set_tenant, BlobStore, QueuedJob, Stores};

/// Chunking defaults (match the reference pipeline).
const CHUNK_TARGET_CHARS: usize = 800;
const CHUNK_OVERLAP_CHARS: usize = 120;

/// Max chunks embedded per inference-svc batch (mirrors the service's
/// INFER_MAX_BATCH default; keeps request bodies + peak RAM bounded).
const EMBED_BATCH: usize = 32;

/// SPLADE (`prithivida/Splade_PP_en_v1`) emits indices over the BERT vocab
/// (30522 terms). pgvector `sparsevec` is 1-indexed, so we shift indices by +1
/// and declare this dimension. Kept in sync with the sparse model.
const SPARSE_DIM: usize = 30522;

/// Cap on how many chunks get an LLM-generated contextual prefix per document
/// (matches CONTEXTUAL_MAX_CHUNKS in the reference pipeline) so a huge document
/// can't run up an unbounded paid-API bill.
const CONTEXTUAL_MAX_CHUNKS: usize = 150;

/// Default confidence floor below which a block is `low_confidence`.
const DEFAULT_LOW_CONF_THRESHOLD: f32 = 0.4;

// ---------------------------------------------------------------------------
// parser-svc wire types (ParsedDoc). camelCase to match the Python service.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParsedPage {
    page_no: i32,
    width: Option<f32>,
    height: Option<f32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParsedBlock {
    kind: String,
    page: i32,
    reading_order: i32,
    content: String,
    #[serde(default)]
    bbox: Option<Vec<f32>>,
    #[serde(default)]
    confidence: Option<f32>,
    #[serde(default)]
    table_markdown: Option<String>,
    #[serde(default)]
    crop_png_base64: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParsedPageImage {
    page_no: i32,
    png_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParsedDoc {
    pages: Vec<ParsedPage>,
    blocks: Vec<ParsedBlock>,
    #[serde(default)]
    #[allow(dead_code)]
    text: String,
    #[serde(default)]
    page_images: Vec<ParsedPageImage>,
    /// True total page count in the source BEFORE the parser's page cap. When
    /// this exceeds the number of emitted pages the document was truncated and
    /// must be flagged `needs_review` rather than silently marked indexed.
    #[serde(default)]
    total_pages: i32,
}

/// parser-svc error payload (`{ "error": "..." }`).
#[derive(Debug, Deserialize)]
struct ParseError {
    error: String,
}

// ---------------------------------------------------------------------------
// Progress stages (percent the FE maps).
// ---------------------------------------------------------------------------

struct Stage {
    status: &'static str,
    progress: i32,
}

const S_EXTRACT: Stage = Stage {
    status: "extract",
    progress: 10,
};
const S_PARSE: Stage = Stage {
    status: "parse",
    progress: 28,
};
const S_CHUNK: Stage = Stage {
    status: "chunk",
    progress: 40,
};
const S_CONTEXTUALIZE: Stage = Stage {
    status: "contextualize",
    progress: 60,
};
const S_EMBED: Stage = Stage {
    status: "embed",
    progress: 85,
};
const S_INDEX: Stage = Stage {
    status: "index",
    progress: 95,
};
const S_DONE: Stage = Stage {
    status: "done",
    progress: 100,
};

/// Job payload fields pulled from `jobs.payload_json`.
struct JobContext {
    document_id: Uuid,
    user_id: Option<Uuid>,
}

fn parse_job_context(job: &QueuedJob) -> anyhow::Result<JobContext> {
    let document_id = job
        .payload
        .get("documentId")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .context("ingest job payload missing/invalid documentId")?;
    let user_id = job
        .payload
        .get("userId")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok());
    Ok(JobContext {
        document_id,
        user_id,
    })
}

fn low_conf_threshold() -> f32 {
    std::env::var("LOW_CONF_THRESHOLD")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_LOW_CONF_THRESHOLD)
}

fn parse_max_pages() -> u32 {
    std::env::var("PARSE_MAX_PAGES")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|n| *n > 0)
        .unwrap_or(40)
}

/// Run the full ingest pipeline for one `ingest` job.
///
/// `parser_url` is the base URL of parser-svc (e.g. `http://parser-svc:8000`).
/// Returns `Err` (after flipping the document to `failed` and publishing a
/// `failed` event) on any parser/IO error; the worker still XACKs.
pub async fn run_ingest(
    stores: &Stores,
    queue: &JobQueue,
    parser_url: &str,
    job: &QueuedJob,
) -> anyhow::Result<()> {
    let ctx = parse_job_context(job)?;
    let tenant_id = job.tenant_id;

    match ingest_inner(stores, queue, parser_url, job, &ctx).await {
        Ok(()) => Ok(()),
        Err(e) => {
            // Best-effort: mark the document failed and publish a failed event.
            if let Err(mark) = mark_document_failed(stores, tenant_id, ctx.document_id).await {
                tracing::error!(
                    document = %ctx.document_id,
                    error = format!("{mark:#}"),
                    "failed to mark document failed after ingest error"
                );
            }
            if let Err(pub_err) = queue
                .publish_progress(
                    tenant_id,
                    ctx.user_id,
                    job.id,
                    "failed",
                    0,
                    Some(&format!("{e:#}")),
                )
                .await
            {
                tracing::error!(
                    job = %job.id,
                    error = format!("{pub_err:#}"),
                    "failed to publish ingest failure event"
                );
            }
            Err(e)
        }
    }
}

async fn mark_document_failed(
    stores: &Stores,
    tenant_id: Uuid,
    document_id: Uuid,
) -> anyhow::Result<()> {
    let mut tx = stores.pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    sqlx::query("UPDATE documents SET status = 'failed' WHERE id = $1")
        .bind(document_id)
        .execute(&mut *tx)
        .await
        .context("mark document failed")?;
    tx.commit().await?;
    Ok(())
}

async fn ingest_inner(
    stores: &Stores,
    queue: &JobQueue,
    parser_url: &str,
    job: &QueuedJob,
    ctx: &JobContext,
) -> anyhow::Result<()> {
    let tenant_id = job.tenant_id;

    // 1. Load the document row (tenant-scoped) for storage_key.
    let (storage_key, source_type) = {
        let mut tx = stores.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;
        let row: Option<(String, String)> =
            sqlx::query_as("SELECT storage_key, source_type FROM documents WHERE id = $1")
                .bind(ctx.document_id)
                .fetch_optional(&mut *tx)
                .await
                .context("load document for ingest")?;
        tx.commit().await?;
        row.with_context(|| format!("document {} not found", ctx.document_id))?
    };

    // 2. extract(10): pull bytes from MinIO.
    stage(queue, tenant_id, ctx, job.id, S_EXTRACT).await?;
    let bytes = stores
        .blobs
        .get_object(&stores.config.buckets.documents, &storage_key)
        .await
        .with_context(|| format!("fetch document bytes for key {storage_key}"))?;

    // 3. parse(28): POST to parser-svc.
    stage(queue, tenant_id, ctx, job.id, S_PARSE).await?;
    let parsed = call_parser(parser_url, &storage_key, bytes).await?;
    anyhow::ensure!(
        !parsed.pages.is_empty() || !parsed.blocks.is_empty(),
        "parser returned no pages and no blocks"
    );

    // 4. chunk(40) — computed before the write tx (pure/no IO).
    stage(queue, tenant_id, ctx, job.id, S_CHUNK).await?;

    // 5. Persist everything in ONE tenant-scoped transaction. Thumbnails and
    //    figure crops are uploaded to MinIO FIRST (outside the tx, against
    //    pre-generated page/block UUIDs) so the pooled DB connection is only
    //    held for SQL, never across S3 round-trips.
    let outcome = persist(
        stores,
        tenant_id,
        ctx.document_id,
        &source_type,
        &parsed,
        low_conf_threshold(),
    )
    .await?;

    // 6. contextualize(60) + embed(85): Phase 5 fills embeddings. The chunks
    //    were written with vector NULL / embedded = false; here we backfill
    //    dense (+ sparse) vectors via inference-svc, and — only if an LLM key
    //    is configured — a per-chunk contextual prefix. Embedding is
    //    resilient: a failure flags the document needs_review but never crashes
    //    the worker (the chunks simply stay unembedded for a later backfill).
    stage(queue, tenant_id, ctx, job.id, S_CONTEXTUALIZE).await?;
    let embed_ok = match embed_document(stores, tenant_id, ctx.document_id).await {
        Ok(embedded) => {
            tracing::info!(document = %ctx.document_id, embedded, "embed stage complete");
            true
        }
        Err(e) => {
            tracing::warn!(
                document = %ctx.document_id,
                error = format!("{e:#}"),
                "embed stage failed; document will need review and a later backfill"
            );
            false
        }
    };
    stage(queue, tenant_id, ctx, job.id, S_EMBED).await?;

    // 7. index(95): flip the document status.
    stage(queue, tenant_id, ctx, job.id, S_INDEX).await?;
    let final_status = if outcome.needs_review || !embed_ok {
        "needs_review"
    } else {
        "indexed"
    };
    {
        let mut tx = stores.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;
        sqlx::query("UPDATE documents SET status = $2 WHERE id = $1")
            .bind(ctx.document_id)
            .bind(final_status)
            .execute(&mut *tx)
            .await
            .context("update document final status")?;
        tx.commit().await?;
    }

    tracing::info!(
        document = %ctx.document_id,
        pages = outcome.pages,
        blocks = outcome.blocks,
        chunks = outcome.chunks,
        status = final_status,
        "ingest complete"
    );

    // 8. done(100).
    stage(queue, tenant_id, ctx, job.id, S_DONE).await?;
    Ok(())
}

/// One unembedded chunk pulled for the embed backfill.
struct UnembeddedChunk {
    id: Uuid,
    text: String,
}

/// Format a SPLADE sparse vector as a pgvector `sparsevec` text literal:
/// `{i1:v1,i2:v2,...}/dim`. Indices are shifted +1 (SPLADE is 0-indexed;
/// sparsevec is 1-indexed) and MUST be strictly increasing and <= dim. Out-of-
/// range or zero-weight terms are dropped defensively. Returns `None` when
/// nothing usable remains (the chunk then gets a NULL sparse column).
fn sparsevec_literal(sv: &retrieve::SparseVector, dim: usize) -> Option<String> {
    let mut pairs: Vec<(usize, f32)> = sv
        .indices
        .iter()
        .zip(sv.values.iter())
        .filter_map(|(&i, &v)| {
            if i < 0 || v == 0.0 || !v.is_finite() {
                return None;
            }
            let idx = (i as usize) + 1; // 0-indexed SPLADE -> 1-indexed sparsevec
            (idx <= dim).then_some((idx, v))
        })
        .collect();
    if pairs.is_empty() {
        return None;
    }
    pairs.sort_by_key(|(idx, _)| *idx);
    pairs.dedup_by_key(|(idx, _)| *idx);
    let body = pairs
        .iter()
        .map(|(idx, v)| format!("{idx}:{v}"))
        .collect::<Vec<_>>()
        .join(",");
    Some(format!("{{{body}}}/{dim}"))
}

/// Backfill dense (+ sparse) embeddings for a document's unembedded chunks, and
/// — only when an LLM key is configured — a per-chunk contextual prefix.
///
/// Resilient by construction: dense embedding is required (a document with no
/// dense vectors is not searchable), but sparse and contextual prefixes are
/// best-effort. Returns the number of chunks marked `embedded = true`. Fully
/// tenant-scoped. The caller treats an `Err` as "needs review", never a crash.
async fn embed_document(
    stores: &Stores,
    tenant_id: Uuid,
    document_id: Uuid,
) -> anyhow::Result<usize> {
    // Pull the unembedded chunks for THIS document (tenant-scoped) with their
    // originating document title for the contextual-prefix prompt.
    let (title, chunks): (String, Vec<UnembeddedChunk>) = {
        let mut tx = stores.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;
        let title: String = sqlx::query_scalar("SELECT title FROM documents WHERE id = $1")
            .bind(document_id)
            .fetch_optional(&mut *tx)
            .await
            .context("load document title for embed")?
            .unwrap_or_default();
        let rows: Vec<(Uuid, String)> = sqlx::query_as(
            "SELECT c.id, c.text FROM chunks c \
             JOIN blocks b ON b.id = c.block_id \
             JOIN pages p ON p.id = b.page_id \
             WHERE p.document_id = $1 AND NOT c.embedded",
        )
        .bind(document_id)
        .fetch_all(&mut *tx)
        .await
        .context("fetch unembedded chunks")?;
        tx.commit().await?;
        (
            title,
            rows.into_iter()
                .map(|(id, text)| UnembeddedChunk { id, text })
                .collect(),
        )
    };

    if chunks.is_empty() {
        return Ok(0);
    }

    // Whether to attempt contextual prefixes at all (no key -> skip entirely).
    let llm_available = crate::llm::provider_available(stores, tenant_id).await;

    let mut embedded = 0usize;
    let mut contextualized = 0usize;
    for (batch_no, batch) in chunks.chunks(EMBED_BATCH).enumerate() {
        let texts: Vec<String> = batch.iter().map(|c| c.text.clone()).collect();

        // Dense is required.
        let dense = retrieve::embed_dense(&texts, false)
            .await
            .context("dense embedding batch")?;
        anyhow::ensure!(
            dense.len() == batch.len(),
            "dense batch size mismatch: got {}, expected {}",
            dense.len(),
            batch.len()
        );

        // Sparse is best-effort: on failure, every chunk in the batch gets a
        // NULL sparse column (dense-only retrieval still works).
        let sparse = retrieve::embed_sparse(&texts).await.unwrap_or_else(|e| {
            tracing::warn!(
                error = format!("{e:#}"),
                "sparse embedding batch failed; dense-only"
            );
            Vec::new()
        });

        let mut tx = stores.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;
        for (i, chunk) in batch.iter().enumerate() {
            let vector = pgvector::Vector::from(dense[i].clone());
            let sparse_literal = sparse
                .get(i)
                .and_then(|sv| sparsevec_literal(sv, SPARSE_DIM));

            // Contextual prefix only when a key is configured and we're under
            // the per-document cap. Best-effort: a failure leaves prefix NULL.
            let prefix = if llm_available && contextualized < CONTEXTUAL_MAX_CHUNKS {
                match crate::llm::contextual_prefix(stores, tenant_id, &title, &chunk.text).await {
                    Ok(Some(p)) => {
                        contextualized += 1;
                        Some(p)
                    }
                    Ok(None) => None,
                    Err(e) => {
                        tracing::warn!(error = format!("{e:#}"), "contextual prefix failed");
                        None
                    }
                }
            } else {
                None
            };

            // Bind sparse as a text literal cast to sparsevec (pgvector has no
            // sqlx encoder for sparsevec here); NULL when absent.
            sqlx::query(
                "UPDATE chunks SET vector = $2, sparse = $3::sparsevec, \
                 contextual_prefix = COALESCE($4, contextual_prefix), embedded = true \
                 WHERE id = $1",
            )
            .bind(chunk.id)
            .bind(vector)
            .bind(sparse_literal)
            .bind(prefix)
            .execute(&mut *tx)
            .await
            .context("update chunk embedding")?;
            embedded += 1;
        }
        tx.commit().await?;
        tracing::debug!(document = %document_id, batch = batch_no, "embedded chunk batch");
    }

    Ok(embedded)
}

async fn stage(
    queue: &JobQueue,
    tenant_id: Uuid,
    ctx: &JobContext,
    job_id: Uuid,
    s: Stage,
) -> anyhow::Result<()> {
    // Abort the pipeline promptly if the job was cancelled between stages.
    if queue.is_cancelled(tenant_id, job_id).await.unwrap_or(false) {
        anyhow::bail!("ingest cancelled by user");
    }
    queue
        .publish_progress(tenant_id, ctx.user_id, job_id, s.status, s.progress, None)
        .await
}

/// POST the uploaded bytes to parser-svc `/parse` and deserialize `ParsedDoc`.
async fn call_parser(
    parser_url: &str,
    storage_key: &str,
    bytes: Vec<u8>,
) -> anyhow::Result<ParsedDoc> {
    let filename = storage_key
        .rsplit('/')
        .next()
        .unwrap_or("upload")
        .to_string();
    let url = format!("{}/parse", parser_url.trim_end_matches('/'));

    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename.clone())
        .mime_str("application/octet-stream")
        .context("building parser multipart part")?;
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("filename", filename)
        .text("max_pages", parse_max_pages().to_string())
        .text("want_thumbnails", "true");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .context("building parser http client")?;
    let resp = client
        .post(&url)
        .multipart(form)
        .send()
        .await
        .with_context(|| format!("POST {url}"))?;

    let status = resp.status();
    let body = resp.bytes().await.context("read parser response body")?;
    if !status.is_success() {
        let msg = serde_json::from_slice::<ParseError>(&body)
            .map(|e| e.error)
            .unwrap_or_else(|_| String::from_utf8_lossy(&body).into_owned());
        anyhow::bail!("parser-svc returned {status}: {msg}");
    }
    serde_json::from_slice::<ParsedDoc>(&body).context("deserialize ParsedDoc")
}

/// Result of the persist transaction, used to pick the final document status.
struct PersistOutcome {
    pages: usize,
    blocks: usize,
    chunks: usize,
    needs_review: bool,
}

/// Page number synthesized for content blocks that carry no provenance
/// (parser emits `page == 0`). We attach these to a real first page rather
/// than dropping them (which would silently lose their text).
const FALLBACK_PAGE_NO: i32 = 1;

/// A block prepared for insertion: identity is pre-assigned so any figure blob
/// can be uploaded to a stable key BEFORE the DB transaction opens.
struct PreparedBlock {
    id: Uuid,
    page_no: i32,
    kind: String,
    bbox_json: Option<serde_json::Value>,
    reading_order: i32,
    content: String,
    table_json: Option<serde_json::Value>,
    confidence: f32,
    /// Coverage status decided up front (`low_confidence` / `skipped`) or the
    /// interim `parsed` that is flipped to `indexed` once chunks are written.
    status: &'static str,
    /// Set to the MinIO object key once a figure crop is uploaded.
    figure_key: Option<String>,
}

/// Persist pages, blocks and chunks in ONE tenant-scoped transaction. All MinIO
/// uploads (page thumbnails, figure crops) happen BEFORE the transaction opens,
/// keyed by pre-generated page/block UUIDs, so the DB connection is never held
/// across an S3 round-trip. Every block is reconciled to a terminal coverage
/// state (`indexed` | `skipped` | `low_confidence`) — none is left at `parsed`.
async fn persist(
    stores: &Stores,
    tenant_id: Uuid,
    document_id: Uuid,
    source_type: &str,
    parsed: &ParsedDoc,
    low_conf_threshold: f32,
) -> anyhow::Result<PersistOutcome> {
    let engine = base64::engine::general_purpose::STANDARD;

    // Any block with page == 0 (no provenance) is reassigned to a fallback page
    // so its text is preserved rather than dropped. We flag needs_review below.
    let has_pageless_block = parsed.blocks.iter().any(|b| b.page <= 0);

    // Blocks grouped by (effective) page for the zero-block coverage check.
    let effective_page = |p: i32| if p <= 0 { FALLBACK_PAGE_NO } else { p };
    let mut blocks_per_page: std::collections::HashMap<i32, usize> =
        std::collections::HashMap::new();
    for b in &parsed.blocks {
        *blocks_per_page.entry(effective_page(b.page)).or_insert(0) += 1;
    }

    // Pages we know about: the union of parser pages and any page a block
    // references (including the fallback page for page-0 blocks).
    let mut page_nos: Vec<i32> = parsed.pages.iter().map(|p| p.page_no).collect();
    for b in &parsed.blocks {
        let pn = effective_page(b.page);
        if !page_nos.contains(&pn) {
            page_nos.push(pn);
        }
    }
    page_nos.sort_unstable();
    page_nos.dedup();

    let dims: std::collections::HashMap<i32, (Option<f32>, Option<f32>)> = parsed
        .pages
        .iter()
        .map(|p| (p.page_no, (p.width, p.height)))
        .collect();

    // --- pre-assign page ids + decode thumbnails (all before the tx) -------
    let mut page_ids: std::collections::HashMap<i32, Uuid> = std::collections::HashMap::new();
    for page_no in &page_nos {
        page_ids.insert(*page_no, Uuid::new_v4());
    }

    // Decode + upload page thumbnails to their pre-known keys, OUTSIDE the tx.
    // A thumbnail failure is best-effort and never fails the ingest.
    let mut page_thumb_keys: std::collections::HashMap<i32, String> =
        std::collections::HashMap::new();
    for img in &parsed.page_images {
        let Some(page_id) = page_ids.get(&img.page_no).copied() else {
            continue;
        };
        let bytes = match engine.decode(img.png_base64.as_bytes()) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(page = img.page_no, error = %e, "bad thumbnail base64; skipping");
                continue;
            }
        };
        let key = format!("thumbs/{tenant_id}/{page_id}.png");
        match stores
            .blobs
            .put_object(&stores.config.buckets.thumbs, &key, bytes)
            .await
        {
            Ok(()) => {
                page_thumb_keys.insert(img.page_no, key);
            }
            Err(e) => {
                tracing::warn!(page = %page_id, error = format!("{e:#}"), "thumbnail upload failed")
            }
        }
    }

    // --- prepare blocks + upload figure crops (all before the tx) ----------
    let mut prepared_blocks: Vec<PreparedBlock> = Vec::with_capacity(parsed.blocks.len());
    for block in &parsed.blocks {
        let page_no = effective_page(block.page);
        // page_no is guaranteed to be in page_ids (we seeded it above).
        let block_id = Uuid::new_v4();
        let confidence = block.confidence.unwrap_or(0.9);
        let has_text = !block.content.trim().is_empty();
        // Terminal status decided up front. Blocks with text stay `parsed`
        // (flipped to `indexed` once chunked); text-less figure/table blocks go
        // straight to the terminal `skipped` so no block lingers at `parsed`.
        let status: &'static str = if confidence < low_conf_threshold {
            "low_confidence"
        } else if has_text {
            "parsed"
        } else {
            "skipped"
        };
        let bbox_json = block.bbox.as_ref().map(|b| serde_json::json!(b));
        let table_json = block
            .table_markdown
            .as_ref()
            .map(|md| serde_json::json!({ "markdown": md }));

        // Upload a figure crop (if present) to its pre-known key, outside the tx.
        let mut figure_key = None;
        if let Some(b64) = &block.crop_png_base64 {
            match engine.decode(b64.as_bytes()) {
                Ok(crop) => {
                    let key = format!("figures/{tenant_id}/{block_id}.png");
                    match stores
                        .blobs
                        .put_object(&stores.config.buckets.figures, &key, crop)
                        .await
                    {
                        Ok(()) => figure_key = Some(key),
                        Err(e) => tracing::warn!(
                            block = %block_id,
                            error = format!("{e:#}"),
                            "figure crop upload failed"
                        ),
                    }
                }
                Err(e) => tracing::warn!(block = %block_id, error = %e, "bad figure crop base64"),
            }
        }

        prepared_blocks.push(PreparedBlock {
            id: block_id,
            page_no,
            kind: block.kind.clone(),
            bbox_json,
            reading_order: block.reading_order,
            content: block.content.clone(),
            table_json,
            confidence,
            status,
            figure_key,
        });
    }

    // A truncated document (parser capped pages away) must be flagged, not
    // silently marked indexed.
    let emitted_pages = parsed.pages.len() as i32;
    let truncated = parsed.total_pages > emitted_pages;
    // needs_review if any page has zero blocks, if there were pageless blocks,
    // if the document was truncated, or if nothing was persisted at all.
    let needs_review = has_pageless_block
        || truncated
        || page_nos.is_empty()
        || page_nos
            .iter()
            .any(|p| blocks_per_page.get(p).copied().unwrap_or(0) == 0);

    // --- one tenant-scoped transaction (SQL only, no network IO) -----------
    let mut tx = stores.pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;

    // Insert pages with explicit ids + pre-uploaded thumb keys.
    for page_no in &page_nos {
        let (w, h) = dims.get(page_no).copied().unwrap_or((None, None));
        let has_blocks = blocks_per_page.get(page_no).copied().unwrap_or(0) > 0;
        let page_status = if has_blocks { "parsed" } else { "needs_review" };
        let page_id = page_ids[page_no];
        let thumb_key = page_thumb_keys.get(page_no);
        sqlx::query(
            "INSERT INTO pages (id, tenant_id, document_id, page_no, width, height, thumb_key, status) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        )
        .bind(page_id)
        .bind(tenant_id)
        .bind(document_id)
        .bind(page_no)
        .bind(w)
        .bind(h)
        .bind(thumb_key)
        .bind(page_status)
        .execute(&mut *tx)
        .await
        .with_context(|| format!("insert page {page_no}"))?;
    }

    // Insert blocks with explicit ids + pre-uploaded figure keys.
    for pb in &prepared_blocks {
        let page_id = page_ids[&pb.page_no];
        sqlx::query(
            "INSERT INTO blocks \
             (id, tenant_id, page_id, kind, bbox, reading_order, text, table_json, figure_key, confidence, status) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
        )
        .bind(pb.id)
        .bind(tenant_id)
        .bind(page_id)
        .bind(&pb.kind)
        .bind(&pb.bbox_json)
        .bind(pb.reading_order)
        .bind(&pb.content)
        .bind(&pb.table_json)
        .bind(&pb.figure_key)
        .bind(pb.confidence)
        .bind(pb.status)
        .execute(&mut *tx)
        .await
        .context("insert block")?;
    }

    // Chunk block text and insert chunk rows (vector NULL / embedded false).
    // Only `parsed` blocks (have text, not low-confidence, not skipped) chunk.
    let mut block_count = 0usize;
    let mut chunk_count = 0usize;
    let mut chunked_block_ids: Vec<Uuid> = Vec::new();
    for pb in &prepared_blocks {
        if !pb.content.trim().is_empty() {
            block_count += 1;
        }
        if pb.status != "parsed" {
            continue;
        }
        let chunks = chunk_text(&pb.content, CHUNK_TARGET_CHARS, CHUNK_OVERLAP_CHARS);
        if chunks.is_empty() {
            continue;
        }
        for chunk in &chunks {
            sqlx::query(
                "INSERT INTO chunks \
                 (tenant_id, vector, text, contextual_prefix, block_id, source_type, embedded) \
                 VALUES ($1, NULL, $2, NULL, $3, $4, false)",
            )
            .bind(tenant_id)
            .bind(chunk)
            .bind(pb.id)
            .bind(source_type)
            .execute(&mut *tx)
            .await
            .context("insert chunk")?;
            chunk_count += 1;
        }
        chunked_block_ids.push(pb.id);
    }

    // Flip chunked blocks to `indexed` (a chunk now references them). Any
    // `parsed` block that produced no chunks is reconciled to the terminal
    // `skipped` so no block is left at the interim `parsed` state.
    for block_id in &chunked_block_ids {
        sqlx::query("UPDATE blocks SET status = 'indexed' WHERE id = $1 AND status = 'parsed'")
            .bind(block_id)
            .execute(&mut *tx)
            .await
            .context("mark block indexed")?;
    }
    sqlx::query(
        "UPDATE blocks b SET status = 'skipped' \
         FROM pages p WHERE b.page_id = p.id AND p.document_id = $1 AND b.status = 'parsed'",
    )
    .bind(document_id)
    .execute(&mut *tx)
    .await
    .context("reconcile leftover parsed blocks to skipped")?;

    tx.commit().await?;

    Ok(PersistOutcome {
        pages: page_ids.len(),
        blocks: block_count,
        chunks: chunk_count,
        needs_review,
    })
}

/// Split `text` into overlapping chunks of ~`target` chars, preferring
/// sentence boundaries. Overlap carries the last `overlap` chars of the
/// previous chunk into the next so context is not lost at seams.
pub fn chunk_text(text: &str, target: usize, overlap: usize) -> Vec<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if trimmed.chars().count() <= target {
        return vec![trimmed.to_string()];
    }

    // Split into sentences on ., !, ? followed by whitespace. Keep the
    // terminator with the sentence.
    let sentences = split_sentences(trimmed);

    let mut chunks: Vec<String> = Vec::new();
    let mut current = String::new();
    for sentence in sentences {
        let sentence = sentence.trim();
        if sentence.is_empty() {
            continue;
        }
        // A single sentence longer than target: hard-split it by chars.
        if sentence.chars().count() > target {
            if !current.is_empty() {
                chunks.push(std::mem::take(&mut current));
            }
            for piece in hard_split(sentence, target, overlap) {
                chunks.push(piece);
            }
            continue;
        }
        let prospective = current.chars().count()
            + if current.is_empty() { 0 } else { 1 }
            + sentence.chars().count();
        if prospective > target && !current.is_empty() {
            let finished = std::mem::take(&mut current);
            // Seed the next chunk with the overlap tail of the finished one.
            current = tail_chars(&finished, overlap);
            chunks.push(finished);
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(sentence);
    }
    if !current.trim().is_empty() {
        chunks.push(current.trim().to_string());
    }
    chunks
}

/// Naive sentence splitter: break after `.`/`!`/`?` when followed by a space.
fn split_sentences(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut buf = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        buf.push(c);
        if matches!(c, '.' | '!' | '?') {
            match chars.peek() {
                Some(next) if next.is_whitespace() => {
                    out.push(std::mem::take(&mut buf));
                }
                None => {}
                _ => {}
            }
        }
    }
    if !buf.trim().is_empty() {
        out.push(buf);
    }
    out
}

/// Return the last `n` chars of `s` (used to seed chunk overlap), trimmed.
fn tail_chars(s: &str, n: usize) -> String {
    if n == 0 {
        return String::new();
    }
    let count = s.chars().count();
    if count <= n {
        return s.trim().to_string();
    }
    s.chars()
        .skip(count - n)
        .collect::<String>()
        .trim_start()
        .to_string()
}

/// Hard-split an over-long sentence into `target`-char windows with `overlap`.
fn hard_split(s: &str, target: usize, overlap: usize) -> Vec<String> {
    let chars: Vec<char> = s.chars().collect();
    let step = target.saturating_sub(overlap).max(1);
    let mut out = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let end = (start + target).min(chars.len());
        out.push(chars[start..end].iter().collect());
        if end == chars.len() {
            break;
        }
        start += step;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text_is_one_chunk() {
        let chunks = chunk_text("Hello world.", 800, 120);
        assert_eq!(chunks, vec!["Hello world.".to_string()]);
    }

    #[test]
    fn empty_text_is_no_chunks() {
        assert!(chunk_text("   ", 800, 120).is_empty());
    }

    #[test]
    fn long_text_splits_with_overlap() {
        let sentence = "The quick brown fox jumps over the lazy dog. ";
        let text = sentence.repeat(40); // ~1800 chars
        let chunks = chunk_text(&text, 200, 40);
        assert!(chunks.len() > 1, "expected multiple chunks");
        for c in &chunks {
            assert!(c.chars().count() <= 200 + 40, "chunk too long: {}", c.len());
        }
    }

    #[test]
    fn over_long_single_sentence_is_hard_split() {
        let text = "a".repeat(500);
        let chunks = chunk_text(&text, 100, 20);
        assert!(chunks.len() >= 5);
        assert!(chunks.iter().all(|c| c.chars().count() <= 100));
    }
}
