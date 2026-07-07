//! Figure/table search across parsed documents. Searches `blocks` of kind
//! figure/table by caption text. Shape: `{ items, total }` of
//! `{ id, documentId, folderId, page, kind, content, title }`.

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::AuthedUser;
use crate::error::ApiError;
use crate::state::AppState;
use insight_core::storage::set_tenant;

#[derive(Debug, Deserialize)]
pub struct FigureQuery {
    q: Option<String>,
}

#[derive(sqlx::FromRow)]
struct FigureRow {
    id: uuid::Uuid,
    document_id: uuid::Uuid,
    folder_id: Option<String>,
    page: i32,
    kind: String,
    content: Option<String>,
    title: String,
}

/// `GET /api/figures?q=` → figure/table blocks matching the caption query.
pub async fn search_figures(
    State(state): State<AppState>,
    user: AuthedUser,
    Query(q): Query<FigureQuery>,
) -> Result<Json<Value>, ApiError> {
    let query = q.q.unwrap_or_default();
    let like = if query.trim().is_empty() {
        None
    } else {
        Some(format!("%{}%", query.trim()))
    };

    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let rows: Vec<FigureRow> = sqlx::query_as(
        "SELECT b.id, d.id AS document_id, d.folder_id, p.page_no AS page, \
                b.kind, b.text AS content, d.title \
         FROM blocks b \
         JOIN pages p ON p.id = b.page_id \
         JOIN documents d ON d.id = p.document_id \
         WHERE b.kind IN ('figure', 'table') \
           AND ($1::text IS NULL OR b.text ILIKE $1) \
         ORDER BY d.added_at DESC LIMIT 50",
    )
    .bind(like.as_deref())
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;

    let items: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.id,
                "documentId": r.document_id,
                "folderId": r.folder_id.clone().unwrap_or_default(),
                "page": r.page,
                "kind": r.kind,
                "content": r.content.clone().unwrap_or_default(),
                "title": r.title,
            })
        })
        .collect();
    let total = items.len();
    Ok(Json(json!({ "items": items, "total": total })))
}
