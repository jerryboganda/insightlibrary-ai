//! insight-worker — consumes the `insight:jobs` Redis Stream (group
//! `workers`). Phase 4 runs the REAL ingest pipeline (`insight_core::ingest::
//! run_ingest`): fetch bytes from MinIO → parse via parser-svc → persist
//! pages/blocks/chunks + thumbnails/figures → publish progress. SIGTERM/ctrl-c
//! drains gracefully: the in-flight job finishes, then the loop exits.

use std::time::Duration;

use insight_core::storage::{JobQueue, QueuedJob, StorageConfig, Stores};
use insight_core::{claims, correlate, graph, ingest, synth};
use uuid::Uuid;

const GROUP: &str = "workers";

/// Run the full knowledge pipeline for a freshly-ingested document:
/// extract claims → correlate (dedup/conflict) → rebuild graph → compile topics.
/// Each step degrades gracefully (no-op without an LLM provider).
async fn run_knowledge(stores: &Stores, job: &QueuedJob) -> anyhow::Result<()> {
    let tenant_id = job.tenant_id;
    if let Some(doc) = job
        .payload
        .get("documentId")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<Uuid>().ok())
    {
        let n = claims::extract_claims(stores, tenant_id, doc).await?;
        tracing::info!(tenant = %tenant_id, document = %doc, claims = n, "claims extracted");
    }
    correlate::correlate(stores, tenant_id).await?;
    graph::build_graph(stores, tenant_id).await?;
    let topics = synth::compile_topics(stores, tenant_id).await?;
    tracing::info!(tenant = %tenant_id, topics, "topics compiled");
    Ok(())
}

/// A pending entry idle this long is considered abandoned (its worker
/// crashed/was killed before XACK) and is reclaimed via XAUTOCLAIM.
/// XREADGROUP with `>` never redelivers PEL entries, so without this a
/// crash mid-job strands the job (and its document) in-flight forever.
const CLAIM_MIN_IDLE_MS: usize = 300_000;
/// How often to sweep for stale pending entries (also runs at startup).
const CLAIM_INTERVAL: Duration = Duration::from_secs(60);

async fn process(stores: &Stores, queue: &JobQueue, parser_url: &str, job: &QueuedJob) {
    tracing::info!(job = %job.id, kind = %job.kind, tenant = %job.tenant_id, "job started");
    let result = match job.kind.as_str() {
        // run_ingest already flips the document to `failed` and publishes a
        // `failed` event on its own error path.
        "ingest" => ingest::run_ingest(stores, queue, parser_url, job).await,
        // Knowledge plane (auto-chained after ingest when autoSsotTopics, or
        // enqueued on demand).
        "knowledge_build" => run_knowledge(stores, job).await,
        "topic_compile" => synth::compile_topics(stores, job.tenant_id)
            .await
            .map(|_| ()),
        "graph_build" => graph::build_graph(stores, job.tenant_id).await.map(|_| ()),
        "correlate" => correlate::correlate(stores, job.tenant_id)
            .await
            .map(|_| ()),
        other => Err(anyhow::anyhow!("unknown job kind {other}")),
    };
    if let Err(e) = &result {
        tracing::error!(job = %job.id, error = format!("{e:#}"), "job failed");
    } else {
        tracing::info!(job = %job.id, "job done");
    }
    if let Err(e) = queue.ack(GROUP, job).await {
        tracing::error!(job = %job.id, error = format!("{e:#}"), "XACK failed");
    }
}

/// Resolves when SIGTERM (unix) or ctrl-c arrives.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigterm = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(e) => {
                tracing::error!(error = %e, "installing SIGTERM handler failed");
                let _ = tokio::signal::ctrl_c().await;
                return;
            }
        };
        tokio::select! {
            _ = sigterm.recv() => {}
            _ = tokio::signal::ctrl_c() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .json()
        .init();

    let config = StorageConfig::from_env()?;
    let stores = Stores::connect(config).await?;
    insight_core::storage::run_migrations(&stores.pool).await?;
    let queue = JobQueue::connect(stores.pool.clone(), &stores.config.redis_url).await?;
    let parser_url =
        std::env::var("PARSER_SVC_URL").unwrap_or_else(|_| "http://parser-svc:8000".into());

    let consumer = format!(
        "{}-{}",
        std::env::var("HOSTNAME").unwrap_or_else(|_| "worker".into()),
        Uuid::new_v4().simple()
    );
    tracing::info!(version = insight_core::VERSION, %consumer, "insight-worker started");

    let mut shutdown = std::pin::pin!(shutdown_signal());
    // `None` forces a reclaim sweep on the first iteration (startup
    // recovery of jobs a previous worker took but never XACKed).
    let mut last_claim: Option<tokio::time::Instant> = None;
    loop {
        if last_claim.is_none_or(|t| t.elapsed() >= CLAIM_INTERVAL) {
            last_claim = Some(tokio::time::Instant::now());
            loop {
                match queue.claim_stale(GROUP, &consumer, CLAIM_MIN_IDLE_MS).await {
                    Ok(Some(job)) => {
                        tracing::warn!(job = %job.id, "reclaimed stale pending job");
                        process(&stores, &queue, &parser_url, &job).await;
                    }
                    Ok(None) => break,
                    Err(e) => {
                        tracing::error!(error = format!("{e:#}"), "stale-job reclaim failed");
                        break;
                    }
                }
            }
        }

        // next_job blocks for at most 5 s, so shutdown latency is bounded;
        // an in-flight `process` always runs to completion (graceful drain).
        tokio::select! {
            _ = &mut shutdown => {
                tracing::info!("shutdown signal received; draining");
                break;
            }
            job = queue.next_job(GROUP, &consumer) => match job {
                Ok(Some(job)) => process(&stores, &queue, &parser_url, &job).await,
                Ok(None) => {} // blocking read timed out; loop to re-check shutdown
                Err(e) => {
                    tracing::error!(error = format!("{e:#}"), "next_job failed; backing off");
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            },
        }
    }
    tracing::info!("insight-worker stopped");
    Ok(())
}
