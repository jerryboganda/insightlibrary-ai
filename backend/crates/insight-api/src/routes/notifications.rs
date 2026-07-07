//! In-app notifications. Shapes match the api-client `Notification`.

use axum::extract::{Path, State};
use axum::Json;
use chrono::SecondsFormat;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::AuthedUser;
use crate::error::ApiError;
use crate::state::AppState;
use insight_core::storage::set_tenant;

#[derive(sqlx::FromRow)]
struct NotifRow {
    id: Uuid,
    kind: String,
    title: String,
    description: String,
    action: Option<String>,
    read: bool,
    archived: bool,
    created_at: chrono::DateTime<chrono::Utc>,
}

fn notif_json(n: &NotifRow) -> Value {
    json!({
        "id": n.id,
        "type": n.kind,
        "title": n.title,
        "description": n.description,
        "time": n.created_at.to_rfc3339_opts(SecondsFormat::Millis, true),
        "read": n.read,
        "action": n.action,
        "archived": n.archived,
    })
}

/// `GET /api/notifications` → `{ items, total }`.
pub async fn list_notifications(
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
    let rows: Vec<NotifRow> = sqlx::query_as(
        "SELECT id, kind, title, description, action, read, archived, created_at \
         FROM notifications WHERE NOT archived ORDER BY created_at DESC LIMIT 200",
    )
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    let items: Vec<Value> = rows.iter().map(notif_json).collect();
    let total = items.len();
    Ok(Json(json!({ "items": items, "total": total })))
}

/// `POST /api/notifications` → mark all read.
pub async fn mark_all_read(
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
    sqlx::query("UPDATE notifications SET read = true WHERE NOT read")
        .execute(&mut *tx)
        .await
        .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
pub struct PatchBody {
    read: Option<bool>,
    archived: Option<bool>,
}

/// `PATCH /api/notifications/{id}`.
pub async fn update_notification(
    State(state): State<AppState>,
    user: AuthedUser,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchBody>,
) -> Result<Json<Value>, ApiError> {
    if body.read.is_none() && body.archived.is_none() {
        return Err(ApiError::bad_request("nothing to update (read, archived)"));
    }
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let row: Option<(bool, bool)> = sqlx::query_as(
        "UPDATE notifications SET \
           read = COALESCE($2, read), archived = COALESCE($3, archived) \
         WHERE id = $1 RETURNING read, archived",
    )
    .bind(id)
    .bind(body.read)
    .bind(body.archived)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    let (read, archived) = row.ok_or_else(|| ApiError::not_found("notification not found"))?;
    let mut out = json!({ "ok": true, "id": id, "read": read });
    if body.archived.is_some() {
        out["archived"] = json!(archived);
        out["archivedPersisted"] = json!(true);
    }
    Ok(Json(out))
}

/// `POST /api/notifications/{id}/archive` → `{ ok, archived }`.
pub async fn archive_notification(
    State(state): State<AppState>,
    user: AuthedUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    sqlx::query("UPDATE notifications SET read = true, archived = true WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(Json(json!({ "ok": true, "archived": true })))
}
