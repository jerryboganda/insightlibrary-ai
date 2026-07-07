//! Hybrid retrieval (Phase 5): dense pgvector KNN + Postgres FTS candidates
//! fused by Reciprocal Rank Fusion (RRF), reranked by the inference-svc
//! cross-encoder, tenant-scoped, and Redis-cached.
//!
//! Everything here is LOCAL and key-free: dense embeddings, rerank, and FTS all
//! run against inference-svc (CPU/ONNX) or Postgres. No paid LLM key is
//! required for search — the LLM only decorates ingest with contextual
//! prefixes when a key happens to be configured (see [`crate::llm`]).
//!
//! Pipeline:
//!   1. embed the query (inference-svc `/embed/dense`),
//!   2. dense candidates: pgvector cosine KNN (tenant-scoped, top `CANDIDATES`),
//!   3. FTS candidates: `websearch_to_tsquery` over `chunks.fts` (top `CANDIDATES`),
//!   4. fuse dense + FTS by RRF (k=60),
//!   5. rerank the top `RERANK_POOL` fused via inference-svc `/rerank`,
//!   6. resolve `document_id` per chunk and return the top `top_k` [`SearchHit`]s.
//!
//! Results are Redis-cached by `(tenant, normalized query, top_k)` for
//! `CACHE_TTL_SECS`; query embeddings are cached by the normalized query. Both
//! keys embed the full (escaped) normalized query, not a hash of it, so two
//! distinct queries can never collide onto one cache entry.

use std::collections::HashMap;

use anyhow::Context;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::storage::vector_store::{ChunkFilter, ChunkHit};
use crate::storage::{set_tenant, Cache, Stores, VectorStore};

/// How many candidates each leg (dense, FTS) fetches before fusion.
const CANDIDATES: i64 = 50;
/// How many fused hits are handed to the cross-encoder reranker.
const RERANK_POOL: usize = 20;
/// RRF constant (standard k=60 dampens the head of each ranked list).
const RRF_K: f64 = 60.0;
/// TTL for the cached final result set.
const CACHE_TTL_SECS: u64 = 300;
/// TTL for cached query embeddings (keyed by content hash).
const EMBED_CACHE_TTL_SECS: u64 = 3600;

/// A single retrieval hit, ready for the API layer to map to the frontend
/// `SearchResult` shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub chunk_id: Uuid,
    pub block_id: Option<Uuid>,
    pub document_id: Option<Uuid>,
    pub text: String,
    /// Short excerpt for display (first ~240 chars, whitespace-collapsed).
    pub snippet: String,
    /// Final relevance score. After rerank this is the normalized (0..1)
    /// cross-encoder score; without a reranker it is the (squashed) RRF score.
    pub score: f64,
}

// ---------------------------------------------------------------------------
// inference-svc client (dense embed + rerank). CPU/ONNX, key-free.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct DenseResponse {
    vectors: Vec<Vec<f32>>,
}

#[derive(Debug, Deserialize)]
struct RerankResult {
    index: usize,
    score: f64,
}

#[derive(Debug, Deserialize)]
struct RerankResponse {
    results: Vec<RerankResult>,
}

fn inference_url() -> String {
    std::env::var("INFERENCE_SVC_URL").unwrap_or_else(|_| "http://inference-svc:8000".into())
}

fn http_client() -> anyhow::Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .context("building inference-svc http client")
}

/// Embed one or more texts via inference-svc `/embed/dense`.
pub async fn embed_dense(texts: &[String], is_query: bool) -> anyhow::Result<Vec<Vec<f32>>> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let url = format!("{}/embed/dense", inference_url().trim_end_matches('/'));
    let resp = http_client()?
        .post(&url)
        .json(&serde_json::json!({ "texts": texts, "is_query": is_query }))
        .send()
        .await
        .with_context(|| format!("POST {url}"))?;
    anyhow::ensure!(
        resp.status().is_success(),
        "inference-svc /embed/dense returned {}",
        resp.status()
    );
    let body: DenseResponse = resp.json().await.context("decode dense response")?;
    Ok(body.vectors)
}

/// One sparse embedding (term index -> weight), from inference-svc
/// `/embed/sparse`. Parallel `indices` / `values` arrays.
#[derive(Debug, Clone, Deserialize)]
pub struct SparseVector {
    pub indices: Vec<i64>,
    pub values: Vec<f32>,
}

#[derive(Debug, Deserialize)]
struct SparseResponse {
    sparse: Vec<SparseVector>,
}

/// Embed one or more texts as SPLADE sparse vectors via inference-svc
/// `/embed/sparse`. Best-effort at call sites (ingest tolerates its absence).
pub async fn embed_sparse(texts: &[String]) -> anyhow::Result<Vec<SparseVector>> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let url = format!("{}/embed/sparse", inference_url().trim_end_matches('/'));
    let resp = http_client()?
        .post(&url)
        .json(&serde_json::json!({ "texts": texts }))
        .send()
        .await
        .with_context(|| format!("POST {url}"))?;
    anyhow::ensure!(
        resp.status().is_success(),
        "inference-svc /embed/sparse returned {}",
        resp.status()
    );
    let body: SparseResponse = resp.json().await.context("decode sparse response")?;
    Ok(body.sparse)
}

/// Rerank `documents` against `query` via inference-svc `/rerank`. Returns
/// `(index, score)` pairs sorted descending by score.
async fn rerank(query: &str, documents: &[String]) -> anyhow::Result<Vec<(usize, f64)>> {
    if documents.is_empty() {
        return Ok(Vec::new());
    }
    let url = format!("{}/rerank", inference_url().trim_end_matches('/'));
    let resp = http_client()?
        .post(&url)
        .json(&serde_json::json!({ "query": query, "documents": documents }))
        .send()
        .await
        .with_context(|| format!("POST {url}"))?;
    anyhow::ensure!(
        resp.status().is_success(),
        "inference-svc /rerank returned {}",
        resp.status()
    );
    let body: RerankResponse = resp.json().await.context("decode rerank response")?;
    Ok(body
        .results
        .into_iter()
        .map(|r| (r.index, r.score))
        .collect())
}

// ---------------------------------------------------------------------------
// Query normalization + embedding cache (by content hash).
// ---------------------------------------------------------------------------

/// Escape a normalized query for safe embedding in a colon-delimited Redis
/// key. Redis keys are binary-safe (spaces are fine), but our keys use `:` as a
/// segment separator, so we percent-escape `:` (and the escape char `%` itself)
/// to keep the query segment unambiguous. Using the full normalized query —
/// rather than a 64-bit hash of it — means two distinct queries can never
/// collide onto the same cache entry and serve each other's results.
fn query_key(query: &str) -> String {
    let mut out = String::with_capacity(query.len());
    for ch in query.chars() {
        match ch {
            '%' => out.push_str("%25"),
            ':' => out.push_str("%3A"),
            _ => out.push(ch),
        }
    }
    out
}

/// Normalize a query for cache keying: trim, collapse internal
/// whitespace, lowercase.
fn normalize_query(query: &str) -> String {
    query
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Embed the query, using a Redis cache keyed by the (escaped) normalized query
/// so repeated searches skip the inference-svc round-trip. Cache errors are
/// non-fatal.
async fn embed_query_cached(stores: &Stores, normalized: &str) -> anyhow::Result<Vec<f32>> {
    let cache_key = format!("qembed:{}", query_key(normalized));
    if let Ok(Some(raw)) = stores.cache.get(&cache_key).await {
        if let Ok(vec) = serde_json::from_str::<Vec<f32>>(&raw) {
            return Ok(vec);
        }
    }
    let mut vectors = embed_dense(&[normalized.to_string()], true).await?;
    let vec = vectors
        .pop()
        .filter(|v| !v.is_empty())
        .context("inference-svc returned no query embedding")?;
    if let Ok(raw) = serde_json::to_string(&vec) {
        let _ = stores
            .cache
            .set_with_ttl(&cache_key, &raw, EMBED_CACHE_TTL_SECS)
            .await;
    }
    Ok(vec)
}

// ---------------------------------------------------------------------------
// RRF fusion + display helpers.
// ---------------------------------------------------------------------------

/// Reciprocal Rank Fusion: fuse ranked candidate lists into a single ordering.
/// Each list contributes `1 / (RRF_K + rank)` (rank 0-indexed) to a chunk's
/// fused score; chunks appearing in multiple lists accumulate. Returns
/// `(ChunkHit, fused_score)` sorted descending, de-duplicated by chunk id.
fn rrf_fuse(lists: &[Vec<ChunkHit>]) -> Vec<(ChunkHit, f64)> {
    let mut scores: HashMap<Uuid, f64> = HashMap::new();
    let mut hits: HashMap<Uuid, ChunkHit> = HashMap::new();
    for list in lists {
        for (rank, hit) in list.iter().enumerate() {
            *scores.entry(hit.id).or_insert(0.0) += 1.0 / (RRF_K + rank as f64);
            hits.entry(hit.id).or_insert_with(|| hit.clone());
        }
    }
    let mut fused: Vec<(ChunkHit, f64)> = hits
        .into_iter()
        .map(|(id, hit)| {
            let score = scores.get(&id).copied().unwrap_or(0.0);
            (hit, score)
        })
        .collect();
    fused.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    fused
}

/// Build a display snippet: collapse whitespace, cap at ~240 chars on a word
/// boundary. Prefers the chunk body (contextual prefix is retrieval metadata).
fn make_snippet(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= 240 {
        return collapsed;
    }
    let mut out: String = collapsed.chars().take(240).collect();
    if let Some(idx) = out.rfind(' ') {
        out.truncate(idx);
    }
    out.push('…');
    out
}

/// Text handed to the reranker: contextual prefix (if present) + body, so the
/// cross-encoder sees the same situating context retrieval used.
fn rerank_text(hit: &ChunkHit) -> String {
    match &hit.contextual_prefix {
        Some(prefix) if !prefix.trim().is_empty() => format!("{prefix}\n\n{}", hit.text),
        _ => hit.text.clone(),
    }
}

/// Logistic squash mapping an unbounded reranker score to (0, 1). RRF scores
/// (small positive) also land in a sane range, so this is safe for both the
/// reranked and the fallback paths.
fn logistic(x: f64) -> f64 {
    1.0 / (1.0 + (-x).exp())
}

/// Resolve `document_id` for a set of chunk block ids (tenant-scoped), via
/// blocks → pages. Chunks with no block, or whose block is gone, map to `None`.
async fn resolve_document_ids(
    stores: &Stores,
    tenant_id: Uuid,
    block_ids: &[Uuid],
) -> anyhow::Result<HashMap<Uuid, Uuid>> {
    if block_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let mut tx = stores.pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    let rows: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT b.id, p.document_id FROM blocks b \
         JOIN pages p ON p.id = b.page_id \
         WHERE b.id = ANY($1)",
    )
    .bind(block_ids)
    .fetch_all(&mut *tx)
    .await
    .context("resolve document ids for blocks")?;
    tx.commit().await?;
    Ok(rows.into_iter().collect())
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/// Run the hybrid retrieval pipeline for `query` under `tenant_id`, returning
/// up to `top_k` [`SearchHit`]s. Fully tenant-scoped and Redis-cached.
///
/// The reranker is best-effort: if inference-svc `/rerank` is unavailable the
/// pipeline falls back to the RRF ordering (still fully functional), so search
/// degrades gracefully rather than failing.
pub async fn search(
    stores: &Stores,
    tenant_id: Uuid,
    query: &str,
    top_k: usize,
) -> anyhow::Result<Vec<SearchHit>> {
    let normalized = normalize_query(query);
    let top_k = top_k.clamp(1, 50);
    if normalized.is_empty() {
        return Ok(Vec::new());
    }

    // --- result cache (tenant + normalized query + top_k) ------------------
    let cache_key = format!("search:{tenant_id}:{top_k}:{}", query_key(&normalized));
    if let Ok(Some(raw)) = stores.cache.get(&cache_key).await {
        if let Ok(hits) = serde_json::from_str::<Vec<SearchHit>>(&raw) {
            return Ok(hits);
        }
    }

    // --- 1. embed the query (cached by content hash) -----------------------
    let query_vec = embed_query_cached(stores, &normalized).await?;

    // --- 2 + 3. dense KNN + FTS candidates, tenant-scoped ------------------
    let filter: Option<&ChunkFilter> = None;
    let dense = stores
        .vectors
        .knn_search(tenant_id, &query_vec, CANDIDATES, filter)
        .await
        .context("dense knn candidates")?;
    let fts = stores
        .vectors
        .fts_search(tenant_id, &normalized, CANDIDATES, filter)
        .await
        .context("fts candidates")?;

    // --- 4. RRF fusion -----------------------------------------------------
    let fused = rrf_fuse(&[dense, fts]);
    if fused.is_empty() {
        // Cache the empty result too (tenant isolation: B searching A's terms
        // must be a fast, stable empty set).
        cache_hits(stores, &cache_key, &[]).await;
        return Ok(Vec::new());
    }

    // --- 5. rerank the top pool (best-effort) ------------------------------
    let pool: Vec<(ChunkHit, f64)> = fused.into_iter().take(RERANK_POOL).collect();
    let docs: Vec<String> = pool.iter().map(|(hit, _)| rerank_text(hit)).collect();

    let ordered: Vec<(ChunkHit, f64)> = match rerank(&normalized, &docs).await {
        Ok(ranked) if !ranked.is_empty() => ranked
            .into_iter()
            .filter_map(|(idx, score)| pool.get(idx).map(|(hit, _)| (hit.clone(), score)))
            .collect(),
        Ok(_) => pool, // reranker returned nothing usable; keep RRF order
        Err(e) => {
            tracing::warn!(
                error = format!("{e:#}"),
                "rerank unavailable; using RRF order"
            );
            pool
        }
    };

    // Normalize scores to 0..1 with a logistic squash so the API `confidence`
    // is always in range regardless of the reranker's raw scale.
    let mut hits: Vec<SearchHit> = ordered
        .into_iter()
        .take(top_k)
        .map(|(hit, score)| SearchHit {
            chunk_id: hit.id,
            block_id: hit.block_id,
            document_id: None,
            snippet: make_snippet(&hit.text),
            text: hit.text,
            score: logistic(score),
        })
        .collect();

    // --- 6. resolve document ids for the final hits ------------------------
    let block_ids: Vec<Uuid> = hits.iter().filter_map(|h| h.block_id).collect();
    let doc_map = resolve_document_ids(stores, tenant_id, &block_ids)
        .await
        .unwrap_or_default();
    for hit in &mut hits {
        if let Some(bid) = hit.block_id {
            hit.document_id = doc_map.get(&bid).copied();
        }
    }

    cache_hits(stores, &cache_key, &hits).await;
    Ok(hits)
}

/// Best-effort cache write of the final result set (errors are swallowed).
async fn cache_hits(stores: &Stores, cache_key: &str, hits: &[SearchHit]) {
    if let Ok(raw) = serde_json::to_string(hits) {
        let _ = stores
            .cache
            .set_with_ttl(cache_key, &raw, CACHE_TTL_SECS)
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(id: Uuid, score: f64) -> ChunkHit {
        ChunkHit {
            id,
            text: "text".into(),
            contextual_prefix: None,
            block_id: None,
            topic: None,
            score,
        }
    }

    #[test]
    fn rrf_rewards_agreement_across_lists() {
        let shared = Uuid::new_v4();
        let only_dense = Uuid::new_v4();
        let only_fts = Uuid::new_v4();
        // `shared` is rank 0 in both lists; the singletons rank 0 in one only.
        let dense = vec![hit(shared, 0.9), hit(only_dense, 0.8)];
        let fts = vec![hit(shared, 5.0), hit(only_fts, 4.0)];
        let fused = rrf_fuse(&[dense, fts]);
        assert_eq!(
            fused.first().unwrap().0.id,
            shared,
            "shared hit ranks first"
        );
        assert_eq!(fused.len(), 3, "de-duplicated union of both lists");
    }

    #[test]
    fn normalize_collapses_and_lowercases() {
        assert_eq!(normalize_query("  Adrenal   CRISIS  "), "adrenal crisis");
    }

    #[test]
    fn query_key_is_injective_and_escapes_separators() {
        // Distinct queries must map to distinct keys (no hash collision).
        assert_ne!(query_key("adrenal crisis"), query_key("adrenal crises"));
        // The `:` segment separator and the `%` escape char are escaped so the
        // query segment can never be confused with another key segment.
        assert_eq!(query_key("a:b"), "a%3Ab");
        assert_eq!(query_key("50%"), "50%25");
        // Two queries that differ only by a literal `:` vs its escape can't
        // alias onto the same key.
        assert_ne!(query_key("a:b"), query_key("a%3Ab"));
    }

    #[test]
    fn snippet_is_capped() {
        let long = "word ".repeat(200);
        let s = make_snippet(&long);
        assert!(s.chars().count() <= 242, "snippet should be capped");
    }

    #[test]
    fn logistic_in_unit_interval() {
        for x in [-10.0, -1.0, 0.0, 1.0, 10.0] {
            let y = logistic(x);
            assert!((0.0..=1.0).contains(&y));
        }
    }
}
