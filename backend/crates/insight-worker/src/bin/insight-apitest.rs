//! insight-apitest — end-to-end acceptance test against a LIVE insight-api
//! (run inside the compose network:
//! `docker compose ... run --rm insight-worker insight-apitest`).
//! Prints one `PASS <name>` / `FAIL <name>: <err>` line per step and exits
//! non-zero on any failure. Configuration: `API_BASE` (default
//! `http://insight-api:8080`).
//!
//! Test-binary conventions: `unwrap`/`expect` are acceptable here (mirrors
//! insight-selftest).

use std::time::Duration;

use anyhow::Context;
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

struct Ctx {
    http: reqwest::Client,
    base: String,
    access: String,
    refresh: String,
}

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
        Ok(0) => println!("apitest: all checks passed"),
        Ok(failures) => {
            println!("apitest: {failures} check(s) failed");
            std::process::exit(1);
        }
        Err(e) => {
            println!("FAIL apitest: {e:#}");
            std::process::exit(1);
        }
    }
}

async fn run_all() -> anyhow::Result<u32> {
    let base = std::env::var("API_BASE").unwrap_or_else(|_| "http://insight-api:8080".into());
    let base = base.trim_end_matches('/').to_string();
    let http = reqwest::Client::builder()
        .cookie_store(true)
        .timeout(Duration::from_secs(30))
        .build()
        .context("building http client")?;

    let mut failures = 0u32;

    // a. health
    let health = async {
        let resp = http.get(format!("{base}/api/health")).send().await?;
        anyhow::ensure!(resp.status() == 200, "status {}", resp.status());
        let body: Value = resp.json().await?;
        anyhow::ensure!(body["status"] == "ok", "body: {body}");
        anyhow::ensure!(body["dataSource"] == "postgres", "body: {body}");
        Ok(())
    }
    .await;
    report("api_health", health, &mut failures);

    // b. sign-up (hard prerequisite for everything below).
    let email = format!("apitest-{}@example.com", uuid_like());
    let password = "apitest-password-123";
    let resp = http
        .post(format!("{base}/api/auth/sign-up"))
        .json(&json!({ "email": email, "password": password, "name": "API Test" }))
        .send()
        .await
        .context("sign-up request")?;
    anyhow::ensure!(resp.status() == 200, "sign-up status {}", resp.status());
    let cookies_set = resp
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .collect::<Vec<_>>()
        .join(";");
    let body: Value = resp.json().await.context("sign-up body")?;
    let access = body["accessToken"]
        .as_str()
        .context("sign-up: no accessToken")?
        .to_string();
    let refresh = body["refreshToken"]
        .as_str()
        .context("sign-up: no refreshToken")?
        .to_string();
    anyhow::ensure!(
        body["user"]["email"] == email.to_lowercase().as_str(),
        "sign-up user email mismatch: {body}"
    );
    anyhow::ensure!(
        cookies_set.contains("insight_access") && cookies_set.contains("insight_refresh"),
        "sign-up did not set auth cookies"
    );
    println!("PASS sign_up");
    let ctx = Ctx {
        http,
        base,
        access,
        refresh,
    };

    // c. session with Bearer.
    let session = async {
        let body: Value = ctx
            .http
            .get(format!("{}/api/session", ctx.base))
            .bearer_auth(&ctx.access)
            .send()
            .await?
            .json()
            .await?;
        anyhow::ensure!(body["authenticated"] == true, "session body: {body}");
        anyhow::ensure!(
            body["user"]["email"] == email.as_str(),
            "session body: {body}"
        );
        Ok(())
    }
    .await;
    report("session_authenticated", session, &mut failures);

    // d. presign + direct PUT through the public S3 host.
    let mut object_key = String::new();
    let presign = async {
        let body: Value = ctx
            .http
            .post(format!("{}/api/uploads/presign", ctx.base))
            .bearer_auth(&ctx.access)
            .json(&json!({ "filename": "apitest.pdf", "contentType": "application/pdf" }))
            .send()
            .await?
            .json()
            .await?;
        anyhow::ensure!(body["method"] == "PUT", "presign body: {body}");
        let url = body["url"].as_str().context("presign: no url")?;
        object_key = body["key"].as_str().context("presign: no key")?.to_string();

        let put = ctx
            .http
            .put(url)
            .body(b"apitest payload: not a real pdf".to_vec())
            .send()
            .await
            .context("PUT to presigned url")?;
        anyhow::ensure!(put.status().is_success(), "PUT status {}", put.status());
        Ok(())
    }
    .await;
    report("presign_and_put", presign, &mut failures);

    // Open the realtime socket BEFORE creating the document so the earliest
    // (queued) event cannot be missed.
    let ws_url = format!(
        "{}/realtime?token={}",
        ctx.base.replacen("http", "ws", 1),
        ctx.access
    );
    let ws = tokio_tungstenite::connect_async(&ws_url).await;

    // e. create document with Idempotency-Key, then replay it.
    let mut document_id = String::new();
    let mut job_id = String::new();
    let idem = uuid_like();
    let create = async {
        anyhow::ensure!(!object_key.is_empty(), "no object key from presign step");
        let request_body = json!({ "key": object_key, "title": "apitest.pdf" });
        let resp = ctx
            .http
            .post(format!("{}/api/documents", ctx.base))
            .bearer_auth(&ctx.access)
            .header("Idempotency-Key", &idem)
            .json(&request_body)
            .send()
            .await?;
        anyhow::ensure!(
            resp.status().is_success(),
            "create status {}",
            resp.status()
        );
        let body: Value = resp.json().await?;
        document_id = body["id"].as_str().context("create: no id")?.to_string();
        job_id = body["jobId"]
            .as_str()
            .context("create: no jobId")?
            .to_string();
        anyhow::ensure!(body["status"] == "processing", "create body: {body}");

        let replay = ctx
            .http
            .post(format!("{}/api/documents", ctx.base))
            .bearer_auth(&ctx.access)
            .header("Idempotency-Key", &idem)
            .json(&request_body)
            .send()
            .await?;
        anyhow::ensure!(
            replay
                .headers()
                .get("Idempotency-Replayed")
                .and_then(|v| v.to_str().ok())
                == Some("true"),
            "replay missing Idempotency-Replayed header"
        );
        let replay_body: Value = replay.json().await?;
        anyhow::ensure!(
            replay_body["id"] == document_id.as_str(),
            "replayed id {} != original {document_id}",
            replay_body["id"]
        );
        Ok(())
    }
    .await;
    report("create_document_idempotent", create, &mut failures);

    // f. realtime job events until done.
    let events = async {
        let (mut socket, _) = ws.context("websocket connect")?;
        anyhow::ensure!(!job_id.is_empty(), "no job id from create step");
        let mut saw_early = false; // queued or running
        let mut saw_done = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        while !saw_done {
            let frame = tokio::time::timeout_at(deadline, socket.next())
                .await
                .context("timed out waiting for job events")?;
            let Some(frame) = frame else {
                anyhow::bail!("websocket closed before job done");
            };
            match frame.context("websocket frame")? {
                Message::Text(text) => {
                    let event: Value = match serde_json::from_str(text.as_str()) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    if event["type"] != "job" || event["id"] != job_id.as_str() {
                        continue;
                    }
                    match event["status"].as_str() {
                        Some("queued") | Some("running") => saw_early = true,
                        Some("done") => saw_done = true,
                        _ => {}
                    }
                }
                Message::Ping(data) => {
                    let _ = socket.send(Message::Pong(data)).await;
                }
                Message::Close(_) => anyhow::bail!("websocket closed before job done"),
                _ => {}
            }
        }
        anyhow::ensure!(saw_early, "never saw a queued/running event");
        let _ = socket.close(None).await;
        Ok(())
    }
    .await;
    report("realtime_job_events", events, &mut failures);

    // g. document is indexed after the job finished.
    let indexed = async {
        anyhow::ensure!(!document_id.is_empty(), "no document id from create step");
        let body: Value = ctx
            .http
            .get(format!("{}/api/documents/{document_id}", ctx.base))
            .bearer_auth(&ctx.access)
            .send()
            .await?
            .json()
            .await?;
        anyhow::ensure!(body["status"] == "indexed", "document body: {body}");
        anyhow::ensure!(body["statusLabel"] == "Indexed", "document body: {body}");
        Ok(())
    }
    .await;
    report("document_indexed", indexed, &mut failures);

    // h. per-tenant rate limit produces a 429 (bounded hammer loop).
    let rate_limit = async {
        for i in 0..400u32 {
            let resp = ctx
                .http
                .get(format!("{}/api/documents", ctx.base))
                .bearer_auth(&ctx.access)
                .send()
                .await?;
            if resp.status() == 429 {
                anyhow::ensure!(
                    resp.headers().contains_key("Retry-After"),
                    "429 without Retry-After"
                );
                println!("  (429 after {} requests)", i + 1);
                return Ok(());
            }
        }
        anyhow::bail!("no 429 within 400 requests")
    }
    .await;
    report("rate_limit_429", rate_limit, &mut failures);

    // i. sign-out revokes the refresh token.
    let signout = async {
        let resp = ctx
            .http
            .post(format!("{}/api/auth/sign-out", ctx.base))
            .bearer_auth(&ctx.access)
            .json(&json!({ "refreshToken": ctx.refresh }))
            .send()
            .await?;
        anyhow::ensure!(
            resp.status().is_success(),
            "sign-out status {}",
            resp.status()
        );

        let refresh_resp = ctx
            .http
            .post(format!("{}/api/auth/refresh", ctx.base))
            .json(&json!({ "refreshToken": ctx.refresh }))
            .send()
            .await?;
        anyhow::ensure!(
            refresh_resp.status() == 401,
            "refresh with revoked token: expected 401, got {}",
            refresh_resp.status()
        );
        Ok(())
    }
    .await;
    report("sign_out_revokes_refresh", signout, &mut failures);

    Ok(failures)
}

/// Random hex id without pulling a uuid dep into the hot path — the worker
/// crate has uuid anyway, so just use it.
fn uuid_like() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}
