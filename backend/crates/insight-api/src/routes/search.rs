//! Hybrid search endpoint (Phase 5), matching docs/frontend-api-surface.md:
//! `GET /api/search?q=` and `POST /api/search {query, topK?}` both return
//! `{ results: [{kind, id, title?, snippet, href, confidence}], total, took_ms }`
//! (camelCase). Tenant-scoped via [`AuthedUser`]; delegates to the local,
//! key-free hybrid pipeline in [`insight_core::retrieve`].

use std::time::Instant;

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::AuthedUser;
use crate::error::ApiError;
use crate::state::AppState;
use insight_core::retrieve::{self, SearchHit};

/// Default number of results when the caller doesn't ask for a specific count.
const DEFAULT_TOP_K: usize = 10;

#[derive(Debug, Deserialize)]
pub struct SearchParams {
    /// `?q=` (canonical) or `?query=` (accepted alias).
    #[serde(alias = "query")]
    q: Option<String>,
    #[serde(alias = "topK")]
    top_k: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchBody {
    #[serde(alias = "q")]
    query: Option<String>,
    top_k: Option<usize>,
}

/// Map a retrieval [`SearchHit`] to the frontend `SearchResult` shape. `href`
/// deep-links the reader to the citing block; `confidence` is the normalized
/// (0..1) rerank/RRF score.
fn hit_to_result(hit: &SearchHit) -> Value {
    let href = match (hit.document_id, hit.block_id) {
        (Some(doc), Some(block)) => format!("/reader?doc={doc}&block={block}"),
        (Some(doc), None) => format!("/reader?doc={doc}"),
        _ => "/reader".to_string(),
    };
    json!({
        "kind": "chunk",
        "id": hit.chunk_id,
        "snippet": hit.snippet,
        "href": href,
        "confidence": hit.score,
    })
}

async fn run_search(
    state: &AppState,
    user: &AuthedUser,
    query: &str,
    top_k: usize,
) -> Result<Json<Value>, ApiError> {
    let query = query.trim();
    if query.is_empty() {
        return Err(ApiError::bad_request("query must not be empty"));
    }
    let started = Instant::now();
    let hits = retrieve::search(&state.stores, user.tenant_id, query, top_k).await?;
    let took_ms = started.elapsed().as_millis() as u64;

    let results: Vec<Value> = hits.iter().map(hit_to_result).collect();
    Ok(Json(json!({
        "results": results,
        "total": results.len(),
        "tookMs": took_ms,
    })))
}

/// `GET /api/search?q=...&topK=...`.
pub async fn search_get(
    user: AuthedUser,
    State(state): State<AppState>,
    Query(params): Query<SearchParams>,
) -> Result<Json<Value>, ApiError> {
    let query = params
        .q
        .ok_or_else(|| ApiError::bad_request("missing required query parameter `q`"))?;
    let top_k = params.top_k.unwrap_or(DEFAULT_TOP_K);
    run_search(&state, &user, &query, top_k).await
}

/// `POST /api/search {query, topK?}`.
pub async fn search_post(
    user: AuthedUser,
    State(state): State<AppState>,
    Json(body): Json<SearchBody>,
) -> Result<Json<Value>, ApiError> {
    let query = body
        .query
        .ok_or_else(|| ApiError::bad_request("missing required field `query`"))?;
    let top_k = body.top_k.unwrap_or(DEFAULT_TOP_K);
    run_search(&state, &user, &query, top_k).await
}
