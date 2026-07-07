//! Workspace API keys. Create/delete require `admin`. The plaintext token is
//! returned exactly once at creation; only its SHA-256 hash is stored.

use axum::extract::{Path, State};
use axum::Json;
use chrono::SecondsFormat;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::{AuthedUser, RequireAdmin};
use crate::error::ApiError;
use crate::state::AppState;
use insight_core::security;
use insight_core::storage::set_tenant;

#[derive(sqlx::FromRow)]
struct KeyRow {
    id: Uuid,
    name: String,
    key_hint: String,
    created_at: chrono::DateTime<chrono::Utc>,
    last_used_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// `GET /api/api-keys` → `{ items, total }`.
pub async fn list_api_keys(
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
    let rows: Vec<KeyRow> = sqlx::query_as(
        "SELECT id, name, key_hint, created_at, last_used_at FROM api_keys \
         WHERE NOT revoked ORDER BY created_at DESC",
    )
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    let items: Vec<Value> = rows
        .iter()
        .map(|k| {
            json!({
                "id": k.id,
                "name": k.name,
                "tokenHint": k.key_hint,
                "createdAt": k.created_at.to_rfc3339_opts(SecondsFormat::Millis, true),
                "lastUsedAt": k.last_used_at.map(|d| d.to_rfc3339_opts(SecondsFormat::Millis, true)),
            })
        })
        .collect();
    let total = items.len();
    Ok(Json(json!({ "items": items, "total": total })))
}

#[derive(Debug, Default, Deserialize)]
pub struct CreateBody {
    name: Option<String>,
}

/// `POST /api/api-keys` (admin) → the created key incl. the one-time token.
pub async fn create_api_key(
    State(state): State<AppState>,
    RequireAdmin(user): RequireAdmin,
    Json(body): Json<CreateBody>,
) -> Result<Json<Value>, ApiError> {
    let name: String = body
        .name
        .unwrap_or_else(|| "API Key".into())
        .chars()
        .take(60)
        .collect();
    let key = security::generate_api_key();
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO api_keys (tenant_id, hash, name, key_hint) VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(user.tenant_id)
    .bind(&key.hash)
    .bind(&name)
    .bind(&key.hint)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(Json(json!({
        "id": id, "name": name, "token": key.plaintext, "tokenHint": key.hint,
    })))
}

/// `DELETE /api/api-keys/{id}` (admin).
pub async fn delete_api_key(
    State(state): State<AppState>,
    RequireAdmin(user): RequireAdmin,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    sqlx::query("DELETE FROM api_keys WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(Json(json!({ "ok": true })))
}
