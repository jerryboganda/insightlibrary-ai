//! Folders: group documents. `docs`/`topics`/`health`/`lastUpdated` are derived
//! at read time. Shapes match the api-client `Folder` + `getFolder` detail.

use axum::extract::{Path, State};
use axum::Json;
use chrono::SecondsFormat;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::AuthedUser;
use crate::error::ApiError;
use crate::routes::documents::{document_json, DOC_TOPIC_COUNTS_SQL};
use crate::state::AppState;
use insight_core::storage::{set_tenant, DocStore};

/// One folder row + derived counts, in the frontend `Folder` shape.
#[derive(sqlx::FromRow)]
struct FolderAgg {
    id: String,
    name: String,
    docs: i64,
    indexed: i64,
    last_updated: Option<chrono::DateTime<chrono::Utc>>,
    updated_at: chrono::DateTime<chrono::Utc>,
}

fn folder_json(f: &FolderAgg, topics: i64) -> Value {
    let health = if f.docs > 0 {
        ((f.indexed as f64 / f.docs as f64) * 100.0).round() as i64
    } else {
        100
    };
    let last = f.last_updated.unwrap_or(f.updated_at);
    json!({
        "id": f.id,
        "name": f.name,
        "docs": f.docs,
        "topics": topics,
        "health": health,
        "lastUpdated": last.to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}

const FOLDER_AGG_SQL: &str = "SELECT f.id, f.name, f.updated_at, \
    COUNT(d.id) AS docs, \
    COUNT(d.id) FILTER (WHERE d.status = 'indexed') AS indexed, \
    MAX(d.added_at) AS last_updated \
  FROM folders f LEFT JOIN documents d ON d.folder_id = f.id \
  {where} GROUP BY f.id, f.name, f.updated_at ORDER BY f.name";

/// Distinct claim-topics grounded across all documents in each folder, keyed by
/// folder id. `{where}` scopes it (all folders, or one) without letting the
/// claim_sources join inflate the folder document counts above.
const FOLDER_TOPIC_COUNTS_SQL: &str = "SELECT d.folder_id, COUNT(DISTINCT c.canonical_topic) \
    FROM documents d JOIN claim_sources cs ON cs.document_id = d.id \
    JOIN claims c ON c.id = cs.claim_id \
    WHERE d.folder_id IS NOT NULL \
      AND c.canonical_topic IS NOT NULL AND c.canonical_topic <> '' {and} \
    GROUP BY d.folder_id";

/// `GET /api/folders` → `Folder[]`.
pub async fn list_folders(
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
    let sql = FOLDER_AGG_SQL.replace("{where}", "");
    let rows: Vec<FolderAgg> = sqlx::query_as(&sql)
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    let topic_sql = FOLDER_TOPIC_COUNTS_SQL.replace("{and}", "");
    let folder_topics: std::collections::HashMap<String, i64> =
        sqlx::query_as::<_, (String, i64)>(&topic_sql)
            .fetch_all(&mut *tx)
            .await
            .map_err(|e| ApiError::from(anyhow::Error::from(e)))?
            .into_iter()
            .collect();
    tx.commit().await.map_err(anyhow::Error::from)?;
    let items: Vec<Value> = rows
        .iter()
        .map(|f| folder_json(f, folder_topics.get(&f.id).copied().unwrap_or(0)))
        .collect();
    let total = items.len();
    Ok(Json(json!({ "items": items, "total": total })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFolderBody {
    name: String,
    parent_id: Option<String>,
}

/// `POST /api/folders` → the created `Folder`.
pub async fn create_folder(
    State(state): State<AppState>,
    user: AuthedUser,
    Json(body): Json<CreateFolderBody>,
) -> Result<Json<Value>, ApiError> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::bad_request("folder name is required"));
    }
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let (id,): (String,) = sqlx::query_as(
        "INSERT INTO folders (tenant_id, name, parent_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(user.tenant_id)
    .bind(name)
    .bind(&body.parent_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;

    Ok(Json(json!({
        "id": id,
        "name": name,
        "docs": 0,
        "topics": 0,
        "health": 100,
        "lastUpdated": chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    })))
}

/// `GET /api/folders/{id}` → `{ folder, documents }`.
pub async fn get_folder(
    State(state): State<AppState>,
    user: AuthedUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let sql = FOLDER_AGG_SQL.replace("{where}", "WHERE f.id = $1");
    let folder: Option<FolderAgg> = sqlx::query_as(&sql)
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    let folder = folder.ok_or_else(|| ApiError::not_found("folder not found"))?;

    // Documents in the folder (reuse the doc list + page counts).
    let rows = state
        .stores
        .docs
        .list_documents(user.tenant_id, Some(&id), 500, 0)
        .await?;
    let doc_ids: Vec<uuid::Uuid> = rows.iter().map(|r| r.id).collect();
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let page_counts: std::collections::HashMap<uuid::Uuid, i64> = sqlx::query_as::<
        _,
        (uuid::Uuid, i64),
    >(
        "SELECT document_id, count(*) FROM pages WHERE document_id = ANY($1) GROUP BY document_id",
    )
    .bind(&doc_ids)
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?
    .into_iter()
    .collect();
    // Folder-level distinct topic count + per-document topic counts.
    let folder_topics: i64 = sqlx::query_scalar(
        "SELECT COUNT(DISTINCT c.canonical_topic) FROM documents d \
         JOIN claim_sources cs ON cs.document_id = d.id \
         JOIN claims c ON c.id = cs.claim_id \
         WHERE d.folder_id = $1 \
           AND c.canonical_topic IS NOT NULL AND c.canonical_topic <> ''",
    )
    .bind(&id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    let topic_counts: std::collections::HashMap<uuid::Uuid, i64> =
        sqlx::query_as::<_, (uuid::Uuid, i64)>(DOC_TOPIC_COUNTS_SQL)
            .bind(&doc_ids)
            .fetch_all(&mut *tx)
            .await
            .map_err(|e| ApiError::from(anyhow::Error::from(e)))?
            .into_iter()
            .collect();
    tx.commit().await.map_err(anyhow::Error::from)?;

    let documents: Vec<Value> = rows
        .iter()
        .map(|r| {
            document_json(
                r,
                page_counts.get(&r.id).copied().unwrap_or(0),
                topic_counts.get(&r.id).copied().unwrap_or(0),
            )
        })
        .collect();

    Ok(Json(
        json!({ "folder": folder_json(&folder, folder_topics), "documents": documents }),
    ))
}
