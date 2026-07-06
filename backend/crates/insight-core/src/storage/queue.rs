//! Minimal Redis Streams job queue.
//!
//! `enqueue` writes a `jobs` row (status `queued`, tenant-scoped tx) and
//! XADDs a pointer entry to the `insight:jobs` stream. Workers consume via
//! XREADGROUP (`next_job`) and XACK (`ack`). Progress goes through
//! [`JobQueue::publish_progress`], which updates the `jobs` row and
//! publishes a JSON event on the `user:{user_id}` pub/sub channel that the
//! API's WebSocket fan-out forwards to connected clients.

use anyhow::Context;
use redis::aio::ConnectionManager;
use redis::streams::{
    StreamAutoClaimOptions, StreamAutoClaimReply, StreamId, StreamMaxlen, StreamReadOptions,
    StreamReadReply,
};
use redis::AsyncCommands;
use sqlx::PgPool;
use uuid::Uuid;

use super::set_tenant;

/// Stream all jobs flow through.
pub const JOB_STREAM: &str = "insight:jobs";

/// Approximate cap on the job stream: XACK only removes entries from the
/// PEL, so without trimming the stream grows with every job ever enqueued.
const JOB_STREAM_MAXLEN: usize = 100_000;

/// A job handed to a worker by [`JobQueue::next_job`].
#[derive(Debug, Clone)]
pub struct QueuedJob {
    /// `jobs.id` row key.
    pub id: Uuid,
    /// Redis stream entry id, needed for [`JobQueue::ack`].
    pub stream_id: String,
    pub tenant_id: Uuid,
    pub kind: String,
    pub payload: serde_json::Value,
}

/// Postgres + Redis Streams job queue. Cheap to clone.
#[derive(Clone)]
pub struct JobQueue {
    pool: PgPool,
    conn: ConnectionManager,
}

impl JobQueue {
    /// Note: blocking reads (`next_job`) stall the underlying multiplexed
    /// connection, so give the worker its own `JobQueue` (own manager)
    /// rather than sharing one with latency-sensitive cache traffic.
    pub async fn connect(pool: PgPool, redis_url: &str) -> anyhow::Result<Self> {
        let client = redis::Client::open(redis_url).context("parsing redis url for job queue")?;
        let conn = client
            .get_connection_manager()
            .await
            .context("connecting job-queue redis manager")?;
        Ok(Self { pool, conn })
    }

    /// Insert a `jobs` row (status `queued`) and announce it on the stream.
    /// Returns the job id. Also publishes the initial `queued` event so
    /// subscribers see the full lifecycle.
    pub async fn enqueue(
        &self,
        kind: &str,
        tenant_id: Uuid,
        payload: &serde_json::Value,
    ) -> anyhow::Result<Uuid> {
        let mut tx = self.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;
        let job_id: Uuid = sqlx::query_scalar(
            "INSERT INTO jobs (tenant_id, kind, payload_json, status) \
             VALUES ($1, $2, $3, 'queued') RETURNING id",
        )
        .bind(tenant_id)
        .bind(kind)
        .bind(payload)
        .fetch_one(&mut *tx)
        .await
        .context("insert job row")?;
        tx.commit().await?;

        let mut conn = self.conn.clone();
        // Publish `queued` BEFORE the XADD: once the entry is on the stream a
        // fast worker can publish `running` immediately, and a late `queued`
        // would make subscribers observe the status regress.
        if let Some(user_id) = payload.get("userId").and_then(|v| v.as_str()) {
            let event = serde_json::json!({
                "type": "job", "id": job_id, "status": "queued", "progress": 0,
            });
            let _: () = conn
                .publish(format!("user:{user_id}"), event.to_string())
                .await
                .context("publish queued event")?;
        }

        let _: String = conn
            .xadd_maxlen(
                JOB_STREAM,
                StreamMaxlen::Approx(JOB_STREAM_MAXLEN),
                "*",
                &[
                    ("job_id", job_id.to_string()),
                    ("tenant_id", tenant_id.to_string()),
                    ("kind", kind.to_string()),
                    ("payload", payload.to_string()),
                ],
            )
            .await
            .context("XADD job to stream")?;
        Ok(job_id)
    }

    /// Blocking-read (5 s) the next job for `group`/`consumer`, creating the
    /// consumer group on first use. `None` when the wait timed out — callers
    /// loop, which doubles as a graceful-shutdown check point.
    pub async fn next_job(&self, group: &str, consumer: &str) -> anyhow::Result<Option<QueuedJob>> {
        let mut conn = self.conn.clone();

        // Create the group (and stream) if missing; BUSYGROUP means another
        // worker won the race, which is fine.
        let created: redis::RedisResult<()> =
            conn.xgroup_create_mkstream(JOB_STREAM, group, "0").await;
        if let Err(e) = created {
            let busy = e
                .code()
                .map(|c| c.starts_with("BUSYGROUP"))
                .unwrap_or(false)
                || e.to_string().contains("BUSYGROUP");
            if !busy {
                return Err(anyhow::Error::from(e).context("XGROUP CREATE"));
            }
        }

        let opts = StreamReadOptions::default()
            .group(group, consumer)
            .count(1)
            .block(5_000);
        let reply: StreamReadReply = conn
            .xread_options(&[JOB_STREAM], &[">"], &opts)
            .await
            .context("XREADGROUP")?;

        let Some(entry) = reply.keys.into_iter().flat_map(|k| k.ids).next() else {
            return Ok(None);
        };
        Ok(Some(parse_job_entry(&entry)?))
    }

    /// Reclaim ONE stale pending entry (delivered but never XACKed — e.g. a
    /// worker crashed mid-job) that has been idle for at least
    /// `min_idle_ms`, transferring it to `consumer`. XREADGROUP with `>`
    /// never redelivers PEL entries, so without this every crash would
    /// strand its in-flight job as `running` forever. Returns `None` when
    /// nothing stale is pending (or the group does not exist yet).
    pub async fn claim_stale(
        &self,
        group: &str,
        consumer: &str,
        min_idle_ms: usize,
    ) -> anyhow::Result<Option<QueuedJob>> {
        let mut conn = self.conn.clone();
        let opts = StreamAutoClaimOptions::default().count(1);
        let reply: redis::RedisResult<StreamAutoClaimReply> = conn
            .xautoclaim_options(JOB_STREAM, group, consumer, min_idle_ms, "0-0", opts)
            .await;
        let reply = match reply {
            Ok(reply) => reply,
            // Group/stream not created yet (first boot before any enqueue).
            Err(e) if e.code() == Some("NOGROUP") => return Ok(None),
            Err(e) => return Err(anyhow::Error::from(e).context("XAUTOCLAIM")),
        };
        let Some(entry) = reply.claimed.first() else {
            return Ok(None);
        };
        Ok(Some(parse_job_entry(entry)?))
    }

    /// Acknowledge a consumed job entry for `group`.
    pub async fn ack(&self, group: &str, job: &QueuedJob) -> anyhow::Result<()> {
        let mut conn = self.conn.clone();
        let _: i64 = conn
            .xack(JOB_STREAM, group, &[&job.stream_id])
            .await
            .context("XACK")?;
        Ok(())
    }

    /// Update the `jobs` row (tenant-scoped tx) and publish a progress event
    /// on `user:{user_id}` for the WebSocket fan-out.
    pub async fn publish_progress(
        &self,
        tenant_id: Uuid,
        user_id: Option<Uuid>,
        job_id: Uuid,
        status: &str,
        progress: i32,
        error: Option<&str>,
    ) -> anyhow::Result<()> {
        let mut tx = self.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;
        sqlx::query(
            "UPDATE jobs SET status = $2, progress = $3, last_error = $4, updated_at = now() \
             WHERE id = $1",
        )
        .bind(job_id)
        .bind(status)
        .bind(progress)
        .bind(error)
        .execute(&mut *tx)
        .await
        .context("update job progress")?;
        tx.commit().await?;

        if let Some(user_id) = user_id {
            let event = serde_json::json!({
                "type": "job", "id": job_id, "status": status, "progress": progress,
            });
            let mut conn = self.conn.clone();
            let _: () = conn
                .publish(format!("user:{user_id}"), event.to_string())
                .await
                .context("publish progress event")?;
        }
        Ok(())
    }
}

/// Decode a stream entry (XREADGROUP or XAUTOCLAIM shape) into a
/// [`QueuedJob`].
fn parse_job_entry(entry: &StreamId) -> anyhow::Result<QueuedJob> {
    let field = |name: &str| -> anyhow::Result<String> {
        match entry.map.get(name) {
            Some(redis::Value::BulkString(bytes)) => {
                Ok(String::from_utf8_lossy(bytes).into_owned())
            }
            Some(redis::Value::SimpleString(s)) => Ok(s.clone()),
            other => anyhow::bail!("stream entry field {name} missing/unexpected: {other:?}"),
        }
    };

    Ok(QueuedJob {
        id: field("job_id")?.parse().context("parse job_id")?,
        stream_id: entry.id.clone(),
        tenant_id: field("tenant_id")?.parse().context("parse tenant_id")?,
        kind: field("kind")?,
        payload: serde_json::from_str(&field("payload")?).context("parse payload json")?,
    })
}
