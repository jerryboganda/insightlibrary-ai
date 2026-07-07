//! Source registry: named sources with a conflict-resolution priority. GET is
//! any member; create/update require `editor`. Shapes match the api-client
//! `Source`.

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::AuthedUser;
use crate::error::ApiError;
use crate::state::AppState;
use insight_core::storage::set_tenant;
use insight_core::tenancy::role_rank;

#[derive(sqlx::FromRow)]
struct SourceRow {
    id: String,
    name: String,
    author: String,
    source_type: String,
    priority: i32,
    source_date: String,
}

fn source_json(s: &SourceRow) -> Value {
    json!({
        "id": s.id,
        "name": s.name,
        "author": s.author,
        "type": s.source_type,
        "priority": s.priority,
        "date": s.source_date,
    })
}

fn require_editor(user: &AuthedUser) -> Result<(), ApiError> {
    if role_rank(&user.role) < role_rank("editor") {
        return Err(ApiError::forbidden("requires editor role or higher"));
    }
    Ok(())
}

/// `GET /api/sources` → `{ items, total }`.
pub async fn list_sources(
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
    let rows: Vec<SourceRow> = sqlx::query_as(
        "SELECT id, name, author, source_type, priority, source_date FROM sources \
         ORDER BY priority, name",
    )
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    let items: Vec<Value> = rows.iter().map(source_json).collect();
    let total = items.len();
    Ok(Json(json!({ "items": items, "total": total })))
}

#[derive(Debug, Deserialize)]
pub struct CreateSourceBody {
    name: String,
    author: Option<String>,
    #[serde(rename = "type")]
    source_type: Option<String>,
    priority: Option<i32>,
    date: Option<String>,
}

/// `POST /api/sources` (editor) → the created `Source`.
pub async fn create_source(
    State(state): State<AppState>,
    user: AuthedUser,
    Json(body): Json<CreateSourceBody>,
) -> Result<Json<Value>, ApiError> {
    require_editor(&user)?;
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::bad_request("source name is required"));
    }
    let author = body.author.unwrap_or_default();
    let source_type = body
        .source_type
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| "Textbook".into());
    let priority = body.priority.unwrap_or(3).clamp(1, 10);
    let date = body
        .date
        .filter(|d| !d.trim().is_empty())
        .unwrap_or_else(|| chrono::Utc::now().format("%Y").to_string());

    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let row: SourceRow = sqlx::query_as(
        "INSERT INTO sources (tenant_id, name, author, source_type, priority, source_date) \
         VALUES ($1, $2, $3, $4, $5, $6) \
         RETURNING id, name, author, source_type, priority, source_date",
    )
    .bind(user.tenant_id)
    .bind(name)
    .bind(&author)
    .bind(&source_type)
    .bind(priority)
    .bind(&date)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(Json(source_json(&row)))
}

#[derive(Debug, Deserialize)]
pub struct PatchSourceBody {
    name: Option<String>,
    author: Option<String>,
    #[serde(rename = "type")]
    source_type: Option<String>,
    priority: Option<i32>,
    date: Option<String>,
}

/// `PATCH /api/sources/{id}` (editor) → the updated `Source`.
pub async fn update_source(
    State(state): State<AppState>,
    user: AuthedUser,
    Path(id): Path<String>,
    Json(body): Json<PatchSourceBody>,
) -> Result<Json<Value>, ApiError> {
    require_editor(&user)?;
    if body.name.is_none()
        && body.author.is_none()
        && body.source_type.is_none()
        && body.priority.is_none()
        && body.date.is_none()
    {
        return Err(ApiError::bad_request("at least one field required"));
    }
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    // COALESCE keeps existing values for omitted fields.
    let row: Option<SourceRow> = sqlx::query_as(
        "UPDATE sources SET \
           name = COALESCE($2, name), \
           author = COALESCE($3, author), \
           source_type = COALESCE($4, source_type), \
           priority = COALESCE($5, priority), \
           source_date = COALESCE($6, source_date), \
           updated_at = now() \
         WHERE id = $1 \
         RETURNING id, name, author, source_type, priority, source_date",
    )
    .bind(&id)
    .bind(body.name.as_deref().map(str::trim))
    .bind(body.author.as_deref())
    .bind(body.source_type.as_deref())
    .bind(body.priority.map(|p| p.clamp(1, 10)))
    .bind(body.date.as_deref())
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    let row = row.ok_or_else(|| ApiError::not_found("source not found"))?;
    Ok(Json(source_json(&row)))
}
