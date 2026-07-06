//! insight-ingest-test — end-to-end acceptance test for the Phase 4 real
//! ingestion pipeline, run inside the compose network:
//! `docker compose ... run --rm insight-worker insight-ingest-test`.
//!
//! It drives a real document through the LIVE stack (insight-api + parser-svc +
//! worker) and asserts the parse actually produced pages/blocks/chunks +
//! thumbnails, checking the DB and MinIO directly. Prints one
//! `PASS <name>` / `FAIL <name>: <err>` line per step; exits non-zero on any
//! failure.
//!
//! Config: `API_BASE` (default `http://insight-api:8080`), `PARSER`
//! (default `http://parser-svc:8000`, informational), `SAMPLE_PDF_URL`
//! (optional; falls back to an in-process generated 3-page PDF so the test is
//! self-contained and never flakes on network). DB + MinIO checks reuse the
//! worker's `StorageConfig::from_env()` (same env the worker runs with).
//!
//! Test-binary conventions: `unwrap`/`expect`/`unwrap_or` are acceptable here
//! (mirrors insight-apitest / insight-selftest).

use std::time::Duration;

use anyhow::Context;
use futures::{SinkExt, StreamExt};
use insight_core::storage::{set_tenant, BlobStore, StorageConfig, Stores};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

fn report(name: &str, result: anyhow::Result<()>, failures: &mut u32) {
    match result {
        Ok(()) => println!("PASS {name}"),
        Err(e) => {
            println!("FAIL {name}: {e:#}");
            *failures += 1;
        }
    }
}

#[tokio::main]
async fn main() {
    match run_all().await {
        Ok(0) => println!("ingest-test: all checks passed"),
        Ok(failures) => {
            println!("ingest-test: {failures} check(s) failed");
            std::process::exit(1);
        }
        Err(e) => {
            println!("FAIL ingest-test: {e:#}");
            std::process::exit(1);
        }
    }
}

async fn run_all() -> anyhow::Result<u32> {
    let base = std::env::var("API_BASE").unwrap_or_else(|_| "http://insight-api:8080".into());
    let base = base.trim_end_matches('/').to_string();
    let http = reqwest::Client::builder()
        .cookie_store(true)
        .timeout(Duration::from_secs(60))
        .build()
        .context("building http client")?;

    let mut failures = 0u32;

    // 1. Obtain a sample multi-page PDF (download or generate).
    let pdf = obtain_sample_pdf(&http).await;
    let pdf = match pdf {
        Ok(bytes) => {
            println!("PASS sample_pdf ({} bytes)", bytes.len());
            bytes
        }
        Err(e) => {
            println!("FAIL sample_pdf: {e:#}");
            return Ok(1); // nothing else can run
        }
    };

    // 2. sign-up.
    let email = format!("ingest-{}@example.com", Uuid::new_v4().simple());
    let password = "ingest-password-123";
    let mut tenant_id = String::new();
    let mut access = String::new();
    let signup = async {
        let resp = http
            .post(format!("{base}/api/auth/sign-up"))
            .json(&json!({ "email": email, "password": password, "name": "Ingest Test" }))
            .send()
            .await?;
        anyhow::ensure!(resp.status() == 200, "sign-up status {}", resp.status());
        let body: Value = resp.json().await?;
        access = body["accessToken"]
            .as_str()
            .context("no accessToken")?
            .to_string();
        tenant_id = body["user"]["tenantId"]
            .as_str()
            .context("no tenantId in sign-up user")?
            .to_string();
        Ok(())
    }
    .await;
    report("sign_up", signup, &mut failures);
    if access.is_empty() {
        return Ok(failures + 1);
    }
    let tenant_uuid: Uuid = tenant_id.parse().unwrap_or_default();

    // 3. presign + PUT the PDF bytes.
    let mut object_key = String::new();
    let presign = async {
        let body: Value = http
            .post(format!("{base}/api/uploads/presign"))
            .bearer_auth(&access)
            .json(&json!({ "filename": "ingest.pdf", "contentType": "application/pdf" }))
            .send()
            .await?
            .json()
            .await?;
        let url = body["url"].as_str().context("presign: no url")?;
        object_key = body["key"].as_str().context("presign: no key")?.to_string();
        let put = http
            .put(url)
            .header("Content-Type", "application/pdf")
            .body(pdf.clone())
            .send()
            .await
            .context("PUT to presigned url")?;
        anyhow::ensure!(put.status().is_success(), "PUT status {}", put.status());
        Ok(())
    }
    .await;
    report("presign_and_put", presign, &mut failures);

    // Open the realtime socket BEFORE creating the document.
    let ws_url = format!(
        "{}/realtime?token={}",
        base.replacen("http", "ws", 1),
        access
    );
    let ws = tokio_tungstenite::connect_async(&ws_url).await;

    // 4. create document.
    let mut document_id = String::new();
    let mut job_id = String::new();
    let create = async {
        anyhow::ensure!(!object_key.is_empty(), "no object key");
        let resp = http
            .post(format!("{base}/api/documents"))
            .bearer_auth(&access)
            .json(&json!({ "key": object_key, "title": "ingest.pdf" }))
            .send()
            .await?;
        anyhow::ensure!(
            resp.status().is_success(),
            "create status {}",
            resp.status()
        );
        let body: Value = resp.json().await?;
        document_id = body["id"].as_str().context("no id")?.to_string();
        job_id = body["jobId"].as_str().context("no jobId")?.to_string();
        Ok(())
    }
    .await;
    report("create_document", create, &mut failures);

    // 5. realtime: assert progress passes `parse` and reaches `done` in 180s.
    let events = async {
        let (mut socket, _) = ws.context("websocket connect")?;
        anyhow::ensure!(!job_id.is_empty(), "no job id");
        let mut saw_parse = false;
        let mut saw_done = false;
        let mut failed_evt: Option<String> = None;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
        while !saw_done {
            let frame = tokio::time::timeout_at(deadline, socket.next())
                .await
                .context("timed out waiting for job to reach done (180s)")?;
            let Some(frame) = frame else {
                anyhow::bail!("websocket closed before done");
            };
            match frame.context("websocket frame")? {
                Message::Text(text) => {
                    let evt: Value = match serde_json::from_str(text.as_str()) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    if evt["type"] != "job" || evt["id"] != job_id.as_str() {
                        continue;
                    }
                    match evt["status"].as_str() {
                        Some("parse") => saw_parse = true,
                        Some("done") => saw_done = true,
                        Some("failed") => {
                            failed_evt = Some(evt.to_string());
                            break;
                        }
                        _ => {}
                    }
                }
                Message::Ping(data) => {
                    let _ = socket.send(Message::Pong(data)).await;
                }
                Message::Close(_) => anyhow::bail!("websocket closed before done"),
                _ => {}
            }
        }
        if let Some(f) = failed_evt {
            anyhow::bail!("ingest job failed: {f}");
        }
        anyhow::ensure!(saw_parse, "never saw a `parse` stage event");
        let _ = socket.close(None).await;
        Ok(())
    }
    .await;
    report("realtime_reaches_done", events, &mut failures);

    // 6. GET document: status indexed|needs_review, pages > 1.
    let doc_check = async {
        anyhow::ensure!(!document_id.is_empty(), "no document id");
        let body: Value = http
            .get(format!("{base}/api/documents/{document_id}"))
            .bearer_auth(&access)
            .send()
            .await?
            .json()
            .await?;
        let status = body["status"].as_str().unwrap_or_default();
        anyhow::ensure!(
            status == "indexed" || status == "needs_review",
            "unexpected status {status}: {body}"
        );
        let pages = body["pages"].as_i64().unwrap_or(0);
        anyhow::ensure!(pages > 1, "expected pages > 1, got {pages}: {body}");
        Ok(())
    }
    .await;
    report("document_indexed_multipage", doc_check, &mut failures);

    // 7 + 8. Direct DB + MinIO assertions under the tenant.
    let doc_uuid: Uuid = document_id.parse().unwrap_or_default();
    let db = db_and_blob_checks(tenant_uuid, doc_uuid).await;
    report("db_and_minio_persistence", db, &mut failures);

    Ok(failures)
}

/// Allowed coverage statuses for blocks — the Phase-4 vocabulary from
/// docs/ingestion-pipeline-reference.md. `chunked` is legacy Node coverage
/// vocabulary the Rust pipeline never emits, so it is intentionally excluded:
/// if the pipeline ever writes it the assertion below will catch the regression.
const BLOCK_STATUSES: &[&str] = &[
    "parsed",
    "indexed",
    "skipped",
    "low_confidence",
    "needs_review",
];

async fn db_and_blob_checks(tenant_id: Uuid, document_id: Uuid) -> anyhow::Result<()> {
    let config = StorageConfig::from_env().context("StorageConfig::from_env")?;
    let thumbs_bucket = config.buckets.thumbs.clone();
    let stores = Stores::connect(config).await.context("Stores::connect")?;

    let mut tx = stores.pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;

    // Pages for this document.
    let page_count: i64 = sqlx::query_scalar("SELECT count(*) FROM pages WHERE document_id = $1")
        .bind(document_id)
        .fetch_one(&mut *tx)
        .await
        .context("count pages")?;
    anyhow::ensure!(page_count > 1, "expected >1 pages, got {page_count}");

    // At least one page has a thumb_key.
    let thumb_key: Option<String> = sqlx::query_scalar(
        "SELECT thumb_key FROM pages WHERE document_id = $1 AND thumb_key IS NOT NULL LIMIT 1",
    )
    .bind(document_id)
    .fetch_optional(&mut *tx)
    .await
    .context("fetch a thumb_key")?
    .flatten();

    // Blocks: rows exist, non-empty text, valid kinds, allowed statuses.
    let valid_kinds = ["text", "heading", "list", "table", "figure", "caption"];
    let block_rows: Vec<(String, Option<String>, String)> = sqlx::query_as(
        "SELECT b.kind, b.text, b.status FROM blocks b \
         JOIN pages p ON p.id = b.page_id \
         WHERE p.document_id = $1",
    )
    .bind(document_id)
    .fetch_all(&mut *tx)
    .await
    .context("fetch blocks")?;
    anyhow::ensure!(!block_rows.is_empty(), "no blocks were persisted");

    let mut nonempty_text = 0usize;
    for (kind, text, status) in &block_rows {
        anyhow::ensure!(
            valid_kinds.contains(&kind.as_str()),
            "invalid block kind {kind}"
        );
        anyhow::ensure!(
            BLOCK_STATUSES.contains(&status.as_str()),
            "block status {status} not in allowed set"
        );
        if text
            .as_deref()
            .map(|t| !t.trim().is_empty())
            .unwrap_or(false)
        {
            nonempty_text += 1;
        }
    }
    anyhow::ensure!(nonempty_text > 0, "no block had non-empty text");

    // Chunks linked to blocks for this document.
    let chunk_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM chunks c \
         JOIN blocks b ON b.id = c.block_id \
         JOIN pages p ON p.id = b.page_id \
         WHERE p.document_id = $1",
    )
    .bind(document_id)
    .fetch_one(&mut *tx)
    .await
    .context("count chunks")?;
    anyhow::ensure!(chunk_count > 0, "no chunks linked to blocks");

    tx.commit().await?;

    println!(
        "  (pages={page_count}, blocks={}, chunks={chunk_count}, blocks_with_text={nonempty_text})",
        block_rows.len()
    );

    // MinIO: thumbnails are best-effort (parser-svc renders them try/except and
    // ingest treats an upload failure as a warning), so an absent thumb_key is
    // NOT a hard failure. But when a thumb_key IS present, the object it names
    // MUST actually exist in MinIO — a dangling key is a real defect.
    match thumb_key {
        Some(thumb_key) => {
            let exists = stores
                .blobs
                .head(&thumbs_bucket, &thumb_key)
                .await
                .context("head thumb object")?;
            anyhow::ensure!(exists, "thumb object {thumb_key} missing from MinIO");
            println!("  (thumb object present: {thumb_key})");
        }
        None => println!(
            "  (no page thumb_key persisted; thumbnails are best-effort — skipping MinIO head)"
        ),
    }

    Ok(())
}

/// Try `SAMPLE_PDF_URL`; on unset/failure, generate a self-contained 3-page PDF.
async fn obtain_sample_pdf(http: &reqwest::Client) -> anyhow::Result<Vec<u8>> {
    if let Ok(url) = std::env::var("SAMPLE_PDF_URL") {
        if !url.trim().is_empty() {
            match http.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok(bytes) = resp.bytes().await {
                        if bytes.len() > 1000 {
                            return Ok(bytes.to_vec());
                        }
                    }
                }
                _ => {}
            }
            eprintln!("SAMPLE_PDF_URL fetch failed; generating a local PDF");
        }
    }
    Ok(generate_sample_pdf())
}

/// Hand-write a minimal, valid 3-page PDF with a heading, paragraphs and a
/// table-like block per page. No external crate: just enough PDF structure for
/// Docling to extract text on multiple pages.
fn generate_sample_pdf() -> Vec<u8> {
    // Page content: one heading, two paragraphs, and a table-ish row per page.
    let pages_text: [&[&str]; 3] = [
        &[
            "Introduction to Ingestion Testing",
            "This is the first page of a synthetic document used by the ingest",
            "acceptance test. It contains several lines of extractable text so",
            "the parser produces multiple blocks with reading order.",
            "Metric    Value    Unit",
            "Latency    42    ms",
        ],
        &[
            "Methods and Materials",
            "The second page continues the document with further paragraphs.",
            "Docling should assign these lines to page two with bounding boxes",
            "and reasonable confidence for the coverage accounting.",
            "Sample    Count    Ratio",
            "Group A    128    0.63",
        ],
        &[
            "Results and Discussion",
            "The third and final page ensures the document is genuinely",
            "multi-page so the pages count is greater than one and per-page",
            "thumbnails are rendered for each page of the file.",
            "Outcome    Score    Grade",
            "Overall    91    A",
        ],
    ];

    // Build content streams (one per page). Uses the standard Helvetica font.
    let mut objects: Vec<Vec<u8>> = Vec::new();
    // We fix object numbering:
    // 1: Catalog, 2: Pages, 3: Font, then per page: Page obj + Content obj.
    let n_pages = pages_text.len();
    let mut page_obj_ids = Vec::new();
    let mut content_obj_ids = Vec::new();
    let mut next_id = 4; // 1..=3 reserved
    for _ in 0..n_pages {
        page_obj_ids.push(next_id);
        content_obj_ids.push(next_id + 1);
        next_id += 2;
    }

    // Object 1: Catalog.
    objects.push(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());
    // Object 2: Pages.
    let kids: String = page_obj_ids
        .iter()
        .map(|id| format!("{id} 0 R"))
        .collect::<Vec<_>>()
        .join(" ");
    objects.push(format!("<< /Type /Pages /Count {n_pages} /Kids [{kids}] >>").into_bytes());
    // Object 3: Font.
    objects.push(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec());

    // Per-page Page + Content objects.
    for (i, lines) in pages_text.iter().enumerate() {
        let content_id = content_obj_ids[i];
        // Page object.
        objects.push(
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] \
                 /Resources << /Font << /F1 3 0 R >> >> /Contents {content_id} 0 R >>"
            )
            .into_bytes(),
        );
        // Content stream: a text block, first line larger (heading).
        let mut stream = String::new();
        stream.push_str("BT\n");
        let mut y = 720;
        for (j, line) in lines.iter().enumerate() {
            let size = if j == 0 { 18 } else { 12 };
            let escaped = line
                .replace('\\', "\\\\")
                .replace('(', "\\(")
                .replace(')', "\\)");
            stream.push_str(&format!(
                "/F1 {size} Tf\n1 0 0 1 72 {y} Tm\n({escaped}) Tj\n"
            ));
            y -= if j == 0 { 32 } else { 20 };
        }
        stream.push_str("ET");
        let stream_obj = format!(
            "<< /Length {} >>\nstream\n{}\nendstream",
            stream.len(),
            stream
        );
        objects.push(stream_obj.into_bytes());
    }

    // Serialize with a cross-reference table.
    let mut out: Vec<u8> = Vec::new();
    out.extend_from_slice(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    let mut offsets: Vec<usize> = Vec::with_capacity(objects.len());
    for (idx, obj) in objects.iter().enumerate() {
        offsets.push(out.len());
        let id = idx + 1;
        out.extend_from_slice(format!("{id} 0 obj\n").as_bytes());
        out.extend_from_slice(obj);
        out.extend_from_slice(b"\nendobj\n");
    }
    let xref_start = out.len();
    let total = objects.len() + 1; // +1 for the free object 0
    out.extend_from_slice(format!("xref\n0 {total}\n").as_bytes());
    out.extend_from_slice(b"0000000000 65535 f \n");
    for off in &offsets {
        out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!("trailer\n<< /Size {total} /Root 1 0 R >>\nstartxref\n{xref_start}\n%%EOF")
            .as_bytes(),
    );
    out
}
