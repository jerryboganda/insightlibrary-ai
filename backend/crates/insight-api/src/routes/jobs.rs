//! Job status endpoint.

use axum::extract::{Path, State};
use axum::Json;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::AuthedUser;
use crate::error::ApiError;
use crate::state::AppState;
use insight_core::storage::set_tenant;

/// `GET /api/jobs/{id}` → `{ id, kind, status, progress, error?, updatedAt }`.
pub async fn get_job(
    user: AuthedUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    #[derive(sqlx::FromRow)]
    struct JobRow {
        id: Uuid,
        kind: String,
        status: String,
        progress: i32,
        last_error: Option<String>,
        updated_at: DateTime<Utc>,
    }

    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let row: Option<JobRow> = sqlx::query_as(
        "SELECT id, kind, status, progress, last_error, updated_at FROM jobs WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;
    tx.commit().await.map_err(anyhow::Error::from)?;

    let job = row.ok_or_else(|| ApiError::not_found("job not found"))?;
    Ok(Json(json!({
        "id": job.id,
        "kind": job.kind,
        "status": job.status,
        "progress": job.progress,
        "error": job.last_error,
        // use_z: the frontend schema (z.iso.datetime()) rejects `+00:00`.
        "updatedAt": job.updated_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    })))
}
