//! Processing pipeline monitor: job list + stats + cancel/retry (editor) and
//! a live SSE stream. Shapes match the api-client `ProcessingJob` /
//! `ProcessingStats`.

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::response::sse::{KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::Json;
use chrono::SecondsFormat;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::AuthedUser;
use crate::error::ApiError;
use crate::sse;
use crate::state::AppState;
use insight_core::storage::{set_tenant, DocStore};
use insight_core::tenancy::role_rank;

/// Present internal `cancelled` as `failed` (the frontend stage enum has no
/// cancelled state).
fn stage_label(status: &str) -> &str {
    match status {
        "cancelled" => "failed",
        s => s,
    }
}

fn require_editor(user: &AuthedUser) -> Result<(), ApiError> {
    if role_rank(&user.role) < role_rank("editor") {
        return Err(ApiError::forbidden("requires editor role or higher"));
    }
    Ok(())
}

#[derive(sqlx::FromRow)]
struct JobRow {
    id: Uuid,
    document_id: Option<String>,
    title: Option<String>,
    status: String,
    progress: i32,
    updated_at: chrono::DateTime<chrono::Utc>,
    last_error: Option<String>,
}

/// `GET /api/processing` → `{ items, total }` of `ProcessingJob`.
pub async fn list_processing(
    State(state): State<AppState>,
    user: AuthedUser,
) -> Result<Json<Value>, ApiError> {
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let rows: Vec<JobRow> = sqlx::query_as(
        "SELECT j.id, j.payload_json->>'documentId' AS document_id, d.title, \
                j.status, j.progress, j.updated_at, j.last_error \
         FROM jobs j \
         LEFT JOIN documents d ON d.id = (j.payload_json->>'documentId')::uuid \
         WHERE j.payload_json ? 'documentId' \
         ORDER BY j.updated_at DESC LIMIT 200",
    )
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;

    let items: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.id,
                "documentId": r.document_id.clone().unwrap_or_default(),
                "documentTitle": r.title.clone().unwrap_or_else(|| "Untitled".into()),
                "stage": stage_label(&r.status),
                "progress": r.progress,
                "startedAt": r.updated_at.to_rfc3339_opts(SecondsFormat::Millis, true),
                "message": r.last_error.clone().unwrap_or_default(),
            })
        })
        .collect();
    let total = items.len();
    Ok(Json(json!({ "items": items, "total": total })))
}

/// `GET /api/processing/stats` → `ProcessingStats`.
pub async fn processing_stats(
    State(state): State<AppState>,
    user: AuthedUser,
) -> Result<Json<Value>, ApiError> {
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;

    let job_counts: Vec<(String, i64)> =
        sqlx::query_as("SELECT status, count(*) FROM jobs GROUP BY status")
            .fetch_all(&mut *tx)
            .await
            .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    let doc_counts: Vec<(String, i64)> =
        sqlx::query_as("SELECT status, count(*) FROM documents GROUP BY status")
            .fetch_all(&mut *tx)
            .await
            .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    let (chunks,): (i64,) = sqlx::query_as("SELECT count(*) FROM chunks")
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    let (claims,): (i64,) = sqlx::query_as("SELECT count(*) FROM claims")
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    let (t24_done, t24_failed): (i64, i64) = sqlx::query_as(
        "SELECT \
           count(*) FILTER (WHERE status = 'done' AND updated_at > now() - interval '24 hours'), \
           count(*) FILTER (WHERE status IN ('failed','cancelled') AND updated_at > now() - interval '24 hours') \
         FROM jobs",
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;

    let mut by_stage = serde_json::Map::new();
    let mut total = 0i64;
    let (mut queued, mut completed, mut failed) = (0i64, 0i64, 0i64);
    for (status, n) in &job_counts {
        by_stage.insert(stage_label(status).to_string(), json!(n));
        total += n;
        match status.as_str() {
            "queued" => queued += n,
            "done" => completed += n,
            "failed" | "cancelled" => failed += n,
            _ => {}
        }
    }
    let active = (total - queued - completed - failed).max(0);
    let by_status: serde_json::Map<String, Value> = doc_counts
        .iter()
        .map(|(s, n)| (s.clone(), json!(n)))
        .collect();
    let doc_total: i64 = doc_counts.iter().map(|(_, n)| n).sum();
    let success_rate = if completed + failed > 0 {
        json!(completed as f64 / (completed + failed) as f64)
    } else {
        Value::Null
    };

    Ok(Json(json!({
        "source": "postgres",
        "jobs": {
            "total": total, "queued": queued, "active": active,
            "completed": completed, "failed": failed, "byStage": by_stage,
        },
        "documents": { "total": doc_total, "byStatus": by_status },
        "chunks": chunks,
        "claims": claims,
        "successRate": success_rate,
        "avgDurationMs": Value::Null,
        "avgStageDurationsMs": Value::Null,
        "throughput24h": { "completed": t24_done, "failed": t24_failed },
    })))
}

/// `POST /api/processing/{id}/cancel` (editor).
pub async fn cancel_job(
    State(state): State<AppState>,
    user: AuthedUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    require_editor(&user)?;
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let row: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT status, payload_json->>'documentId' FROM jobs WHERE id = $1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    let Some((status, document_id)) = row else {
        tx.commit().await.ok();
        return Err(ApiError::not_found("processing job not found"));
    };
    if status == "done" {
        tx.commit().await.ok();
        return Ok(Json(json!({ "ok": true, "alreadyCompleted": true })));
    }
    // The worker checks for the cancelled status between stages and aborts.
    sqlx::query(
        "UPDATE jobs SET status = 'cancelled', last_error = 'Cancelled by user', updated_at = now() \
         WHERE id = $1",
    )
    .bind(id)
    .execute(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    if let Some(doc_id) = document_id.as_deref().and_then(|s| s.parse::<Uuid>().ok()) {
        sqlx::query("UPDATE documents SET status = 'failed' WHERE id = $1")
            .bind(doc_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    }
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(Json(json!({ "ok": true })))
}

/// `POST /api/processing/{id}/retry` (editor) — re-enqueue the document's ingest.
pub async fn retry_job(
    State(state): State<AppState>,
    user: AuthedUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    require_editor(&user)?;
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let doc: Option<(Option<String>,)> =
        sqlx::query_as("SELECT payload_json->>'documentId' FROM jobs WHERE id = $1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    let document_id = doc
        .and_then(|d| d.0)
        .and_then(|s| s.parse::<Uuid>().ok())
        .ok_or_else(|| ApiError::not_found("job not found"))?;

    state
        .stores
        .docs
        .update_document_status(user.tenant_id, document_id, "processing")
        .await?;
    state
        .queue
        .enqueue(
            "ingest",
            user.tenant_id,
            &json!({ "documentId": document_id, "userId": user.user_id }),
        )
        .await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
pub struct StreamQuery {
    access_token: Option<String>,
}

/// `GET /api/processing/stream` — live SSE of tenant job progress. EventSource
/// auth via cookie or `?access_token=`.
pub async fn processing_stream(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<StreamQuery>,
) -> Result<axum::response::Response, ApiError> {
    let user = sse::authed_for_sse(&state, &headers, q.access_token.as_deref())?;
    let channel = format!("tenant:{}:jobs", user.tenant_id);
    let stream = sse::subscribe_stream(&state.stores.config.redis_url, channel)
        .await
        .map_err(ApiError::from)?;
    Ok(Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response())
}
