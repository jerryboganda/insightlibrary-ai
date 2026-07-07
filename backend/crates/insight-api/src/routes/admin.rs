//! Admin ops: reindex unembedded chunks + storage/index statistics. Both
//! require admin.

use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use crate::auth::RequireAdmin;
use crate::error::ApiError;
use crate::state::AppState;
use insight_core::retrieve;
use insight_core::storage::set_tenant;

const REINDEX_BATCH: i64 = 500;

/// `POST /api/admin/reindex` (admin) → `{ reembedded, remaining }`.
pub async fn reindex(
    State(state): State<AppState>,
    RequireAdmin(user): RequireAdmin,
) -> Result<Json<Value>, ApiError> {
    let (reembedded, remaining) =
        retrieve::reindex_unembedded(&state.stores, user.tenant_id, REINDEX_BATCH)
            .await
            .map_err(ApiError::from)?;
    Ok(Json(
        json!({ "reembedded": reembedded, "remaining": remaining }),
    ))
}

/// `GET /api/admin/storage-stats` (admin).
pub async fn storage_stats(
    State(state): State<AppState>,
    RequireAdmin(user): RequireAdmin,
) -> Result<Json<Value>, ApiError> {
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;

    // Org-scoped counts.
    let (documents,): (i64,) = sqlx::query_as("SELECT count(*) FROM documents")
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    let (chunks,): (i64,) = sqlx::query_as("SELECT count(*) FROM chunks")
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    let (embedded_chunks,): (i64,) = sqlx::query_as("SELECT count(*) FROM chunks WHERE embedded")
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    let (doc_blocks,): (i64,) = sqlx::query_as("SELECT count(*) FROM blocks")
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    let (graph_nodes,): (i64,) = sqlx::query_as("SELECT count(*) FROM nodes")
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    let (graph_edges,): (i64,) = sqlx::query_as("SELECT count(*) FROM edges")
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    let (claims,): (i64,) = sqlx::query_as("SELECT count(*) FROM claims")
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;

    // DB table sizes (global, not tenant-scoped; best-effort).
    let table_size =
        |name: &str| -> String { format!("SELECT pg_total_relation_size('{name}')::bigint") };
    let mut tables = serde_json::Map::new();
    for t in ["chunks", "blocks", "nodes", "edges", "claims"] {
        let size: Option<i64> = sqlx::query_scalar(&table_size(t))
            .fetch_one(&mut *tx)
            .await
            .ok();
        let key = match t {
            "blocks" => "docBlocks",
            "nodes" => "graphNodes",
            "edges" => "graphEdges",
            other => other,
        };
        tables.insert(key.to_string(), json!(size));
    }
    let (total_bytes,): (Option<i64>,) =
        sqlx::query_as("SELECT pg_database_size(current_database())::bigint")
            .fetch_one(&mut *tx)
            .await
            .unwrap_or((None,));
    tx.commit().await.map_err(anyhow::Error::from)?;

    Ok(Json(json!({
        "source": "postgres",
        "database": { "totalBytes": total_bytes, "tables": tables },
        "counts": {
            "documents": documents,
            "chunks": chunks,
            "embeddedChunks": embedded_chunks,
            "docBlocks": doc_blocks,
            "graphNodes": graph_nodes,
            "graphEdges": graph_edges,
            "claims": claims,
        },
        "s3": {
            "configured": true,
            "prefix": format!("{}/", user.tenant_id),
            "bytes": Value::Null,
            "objects": Value::Null,
            "truncated": false,
            "cachedAt": Value::Null,
        },
    })))
}
