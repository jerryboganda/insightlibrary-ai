//! insight-search-test — end-to-end acceptance test for the Phase 5 hybrid
//! retrieval + search stack, run inside the compose network:
//! `docker compose ... run --rm insight-worker insight-search-test`.
//!
//! It drives a real multi-topic document through the LIVE stack (insight-api +
//! parser-svc + inference-svc + worker), then exercises `/api/search` and
//! asserts:
//!   1. tenant A + tenant B sign up,
//!   2. A ingests a multi-topic PDF (distinctive "adrenal crisis" page vs an
//!      unrelated page) and it reaches `done`,
//!   3. chunks were embedded (DB: embedded=true AND vector IS NOT NULL > 0),
//!   4. A's search for "adrenal crisis management" returns the adrenal page,
//!      with an href referencing a real block/document of tenant A,
//!   5. tenant isolation: B's identical search returns ZERO results,
//!   6. cache: A's repeated search returns the identical ordering.
//!
//! Prints `PASS <name>` / `FAIL <name>: <err>` per step; exits non-zero on any
//! failure.
//!
//! Config: `API_BASE` (default `http://insight-api:8080`). DB asserts reuse the
//! worker's `StorageConfig::from_env()`. Test-binary conventions:
//! `unwrap`/`expect`/`unwrap_or` are acceptable here (mirrors the sibling test
//! bins).

use std::time::Duration;

use anyhow::Context;
use futures::{SinkExt, StreamExt};
use insight_core::storage::{set_tenant, StorageConfig, Stores};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

/// The distinctive query the adrenal page should win.
const ADRENAL_QUERY: &str = "adrenal crisis management";
/// A sentinel string that appears ONLY on the adrenal page, used to confirm the
/// top hit's snippet came from the right page.
const ADRENAL_SENTINEL: &str = "Addison";

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
        Ok(0) => println!("search-test: all checks passed"),
        Ok(failures) => {
            println!("search-test: {failures} check(s) failed");
            std::process::exit(1);
        }
        Err(e) => {
            println!("FAIL search-test: {e:#}");
            std::process::exit(1);
        }
    }
}

/// A signed-up tenant: its access token + tenant id.
struct Tenant {
    access: String,
    tenant_id: Uuid,
}

async fn sign_up(http: &reqwest::Client, base: &str, label: &str) -> anyhow::Result<Tenant> {
    let email = format!("search-{label}-{}@example.com", Uuid::new_v4().simple());
    let resp = http
        .post(format!("{base}/api/auth/sign-up"))
        .json(&json!({ "email": email, "password": "search-password-123", "name": "Search Test" }))
        .send()
        .await?;
    anyhow::ensure!(resp.status() == 200, "sign-up status {}", resp.status());
    let body: Value = resp.json().await?;
    let access = body["accessToken"]
        .as_str()
        .context("no accessToken")?
        .to_string();
    let tenant_id: Uuid = body["user"]["tenantId"]
        .as_str()
        .context("no tenantId")?
        .parse()
        .context("tenantId parse")?;
    Ok(Tenant { access, tenant_id })
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

    // 1. sign up tenant A + tenant B.
    let tenant_a = match sign_up(&http, &base, "a").await {
        Ok(t) => {
            println!("PASS sign_up_tenant_a");
            t
        }
        Err(e) => {
            println!("FAIL sign_up_tenant_a: {e:#}");
            return Ok(1);
        }
    };
    let tenant_b = match sign_up(&http, &base, "b").await {
        Ok(t) => {
            println!("PASS sign_up_tenant_b");
            t
        }
        Err(e) => {
            println!("FAIL sign_up_tenant_b: {e:#}");
            return Ok(1);
        }
    };

    // 2. As A: presign + PUT the multi-topic PDF, create the document, wait for
    //    ingest to reach `done`.
    let pdf = generate_multitopic_pdf();
    let mut object_key = String::new();
    let presign = async {
        let body: Value = http
            .post(format!("{base}/api/uploads/presign"))
            .bearer_auth(&tenant_a.access)
            .json(&json!({ "filename": "search.pdf", "contentType": "application/pdf" }))
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
        tenant_a.access
    );
    let ws = tokio_tungstenite::connect_async(&ws_url).await;

    let mut document_id = String::new();
    let mut job_id = String::new();
    let create = async {
        anyhow::ensure!(!object_key.is_empty(), "no object key");
        let resp = http
            .post(format!("{base}/api/documents"))
            .bearer_auth(&tenant_a.access)
            .json(&json!({ "key": object_key, "title": "search.pdf" }))
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

    // Wait for `done` (models are baked, so this is fast). 240s ceiling to
    // cover parse + embed on the shared CPU box.
    let events = async {
        let (mut socket, _) = ws.context("websocket connect")?;
        anyhow::ensure!(!job_id.is_empty(), "no job id");
        let mut saw_done = false;
        let mut failed_evt: Option<String> = None;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(240);
        while !saw_done {
            let frame = tokio::time::timeout_at(deadline, socket.next())
                .await
                .context("timed out waiting for job to reach done (240s)")?;
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
        let _ = socket.close(None).await;
        Ok(())
    }
    .await;
    report("ingest_reaches_done", events, &mut failures);

    let doc_uuid: Uuid = document_id.parse().unwrap_or_default();

    // 3. Chunks embedded for tenant A (DB assertion).
    let embed_check = assert_chunks_embedded(tenant_a.tenant_id, doc_uuid).await;
    report("chunks_embedded", embed_check, &mut failures);

    // 4. As A: search finds the adrenal page, with a real href.
    let mut first_ordering: Vec<String> = Vec::new();
    let search_a = async {
        let body = search(&http, &base, &tenant_a.access, ADRENAL_QUERY).await?;
        let results = body["results"].as_array().context("results not an array")?;
        anyhow::ensure!(!results.is_empty(), "tenant A search returned no results");

        let top = &results[0];
        let snippet = top["snippet"].as_str().unwrap_or_default();
        anyhow::ensure!(
            snippet.contains(ADRENAL_SENTINEL),
            "top snippet is not from the adrenal page: {snippet:?}"
        );
        // href must deep-link to a real document (tenant A's doc id).
        let href = top["href"].as_str().unwrap_or_default();
        anyhow::ensure!(
            href.contains(&document_id) && href.contains("block="),
            "top href {href:?} does not reference tenant A's document + a block"
        );
        anyhow::ensure!(top["kind"] == "chunk", "kind should be chunk");
        let conf = top["confidence"].as_f64().unwrap_or(-1.0);
        anyhow::ensure!((0.0..=1.0).contains(&conf), "confidence {conf} out of 0..1");

        first_ordering = results
            .iter()
            .filter_map(|r| r["id"].as_str().map(str::to_string))
            .collect();
        println!("  (tenant A got {} results; top snippet ok)", results.len());
        Ok(())
    }
    .await;
    report("search_finds_adrenal_page", search_a, &mut failures);

    // 5. Tenant isolation: B's identical search returns ZERO results.
    let isolation = async {
        let body = search(&http, &base, &tenant_b.access, ADRENAL_QUERY).await?;
        let results = body["results"].as_array().context("results not an array")?;
        anyhow::ensure!(
            results.is_empty(),
            "tenant B leaked {} result(s) for A's document",
            results.len()
        );
        Ok(())
    }
    .await;
    report("tenant_isolation_zero_results", isolation, &mut failures);

    // 6. Cache: A's repeated search returns the identical ordering.
    let cache_check = async {
        anyhow::ensure!(
            !first_ordering.is_empty(),
            "no first-run ordering to compare (search step failed)"
        );
        let body = search(&http, &base, &tenant_a.access, ADRENAL_QUERY).await?;
        let second: Vec<String> = body["results"]
            .as_array()
            .context("results not an array")?
            .iter()
            .filter_map(|r| r["id"].as_str().map(str::to_string))
            .collect();
        anyhow::ensure!(
            second == first_ordering,
            "cached ordering differs: {second:?} != {first_ordering:?}"
        );
        Ok(())
    }
    .await;
    report("cache_identical_ordering", cache_check, &mut failures);

    Ok(failures)
}

/// `GET /api/search?q=`, returning the parsed JSON body.
async fn search(
    http: &reqwest::Client,
    base: &str,
    access: &str,
    query: &str,
) -> anyhow::Result<Value> {
    let resp = http
        .get(format!("{base}/api/search"))
        .query(&[("q", query)])
        .bearer_auth(access)
        .send()
        .await
        .context("GET /api/search")?;
    anyhow::ensure!(
        resp.status().is_success(),
        "search status {}",
        resp.status()
    );
    resp.json().await.context("decode search response")
}

/// DB assertion: tenant A's document has embedded chunks with a real vector.
async fn assert_chunks_embedded(tenant_id: Uuid, document_id: Uuid) -> anyhow::Result<()> {
    let config = StorageConfig::from_env().context("StorageConfig::from_env")?;
    let stores = Stores::connect(config).await.context("Stores::connect")?;

    let mut tx = stores.pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    let embedded: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM chunks c \
         JOIN blocks b ON b.id = c.block_id \
         JOIN pages p ON p.id = b.page_id \
         WHERE p.document_id = $1 AND c.embedded = true AND c.vector IS NOT NULL",
    )
    .bind(document_id)
    .fetch_one(&mut *tx)
    .await
    .context("count embedded chunks")?;
    tx.commit().await?;
    anyhow::ensure!(
        embedded > 0,
        "expected embedded chunks with a vector, got {embedded}"
    );
    println!("  (embedded chunks with vector: {embedded})");
    Ok(())
}

/// Hand-write a 2-page multi-topic PDF: page 1 is distinctively about adrenal
/// crisis / Addison disease; page 2 is an unrelated topic (photosynthesis) so
/// the search must actually discriminate. No external crate — just enough PDF
/// structure for Docling to extract text on both pages.
fn generate_multitopic_pdf() -> Vec<u8> {
    let pages_text: [&[&str]; 2] = [
        &[
            "Adrenal Crisis Management in Addison Disease",
            "Adrenal crisis is a life-threatening emergency in patients with",
            "Addison disease and primary adrenal insufficiency. Immediate",
            "management requires intravenous hydrocortisone, aggressive fluid",
            "resuscitation with normal saline, and correction of hypoglycemia.",
            "Recognizing adrenal crisis early and administering stress-dose",
            "glucocorticoids prevents shock and death in Addison disease.",
        ],
        &[
            "An Overview of Photosynthesis in Green Plants",
            "Photosynthesis converts light energy into chemical energy stored",
            "in glucose. In the chloroplast, the light-dependent reactions split",
            "water and produce ATP and NADPH, which the Calvin cycle uses to",
            "fix carbon dioxide into sugars. This process underpins nearly all",
            "food chains and releases the oxygen that terrestrial life breathes.",
        ],
    ];

    let mut objects: Vec<Vec<u8>> = Vec::new();
    let n_pages = pages_text.len();
    let mut page_obj_ids = Vec::new();
    let mut content_obj_ids = Vec::new();
    let mut next_id = 4; // 1..=3 reserved (Catalog, Pages, Font)
    for _ in 0..n_pages {
        page_obj_ids.push(next_id);
        content_obj_ids.push(next_id + 1);
        next_id += 2;
    }

    objects.push(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());
    let kids: String = page_obj_ids
        .iter()
        .map(|id| format!("{id} 0 R"))
        .collect::<Vec<_>>()
        .join(" ");
    objects.push(format!("<< /Type /Pages /Count {n_pages} /Kids [{kids}] >>").into_bytes());
    objects.push(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec());

    for (i, lines) in pages_text.iter().enumerate() {
        let content_id = content_obj_ids[i];
        objects.push(
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] \
                 /Resources << /Font << /F1 3 0 R >> >> /Contents {content_id} 0 R >>"
            )
            .into_bytes(),
        );
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
    let total = objects.len() + 1;
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
