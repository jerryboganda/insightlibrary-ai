//! Vector store over Postgres + pgvector: chunk upsert, cosine KNN search
//! (HNSW-indexed), and deletion by source block. Tenant-scoped via RLS.

use std::sync::{Arc, OnceLock};

use anyhow::Context;
use chrono::{DateTime, Utc};
use pgvector::Vector;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use super::set_tenant;

/// Dense embedding dimension for `chunks.vector` (`vector(768)`).
pub const CHUNK_DIM: usize = 768;

/// Chunk payload for [`VectorStore::upsert_chunks`].
#[derive(Debug, Clone)]
pub struct NewChunk {
    /// Provide to upsert a specific row; `None` generates a fresh id.
    /// A provided id MUST belong to the calling tenant: an id owned by
    /// another tenant fails (RLS policy violation or a clear "owned by
    /// another tenant" error from the tenant-scoped conflict update) —
    /// it never touches the foreign row.
    pub id: Option<Uuid>,
    pub vector: Vec<f32>,
    pub text: String,
    pub contextual_prefix: Option<String>,
    pub block_id: Option<Uuid>,
    pub topic: Option<String>,
    pub system_tags: Option<serde_json::Value>,
    pub source_type: Option<String>,
    pub date: Option<DateTime<Utc>>,
}

/// Optional metadata filter for [`VectorStore::knn_search`].
#[derive(Debug, Clone, Default)]
pub struct ChunkFilter {
    pub source_type: Option<String>,
    pub topic: Option<String>,
}

/// KNN search hit; `score` is cosine similarity (1 - cosine distance).
#[derive(Debug, Clone)]
pub struct ChunkHit {
    pub id: Uuid,
    pub text: String,
    pub contextual_prefix: Option<String>,
    pub block_id: Option<Uuid>,
    pub topic: Option<String>,
    pub score: f64,
}

/// Raw KNN row (distance, not similarity) as fetched from Postgres.
#[derive(sqlx::FromRow)]
struct KnnRow {
    id: Uuid,
    text: String,
    contextual_prefix: Option<String>,
    block_id: Option<Uuid>,
    topic: Option<String>,
    distance: f64,
}

/// Raw FTS row (`ts_rank` relevance, higher is better) from Postgres.
#[derive(sqlx::FromRow)]
struct FtsRow {
    id: Uuid,
    text: String,
    contextual_prefix: Option<String>,
    block_id: Option<Uuid>,
    topic: Option<String>,
    rank: f64,
}

/// Embedding persistence + similarity search. Native async-fn-in-trait.
#[allow(async_fn_in_trait)]
pub trait VectorStore {
    async fn upsert_chunks(
        &self,
        tenant_id: Uuid,
        chunks: &[NewChunk],
    ) -> anyhow::Result<Vec<Uuid>>;
    async fn knn_search(
        &self,
        tenant_id: Uuid,
        query_vec: &[f32],
        k: i64,
        filter: Option<&ChunkFilter>,
    ) -> anyhow::Result<Vec<ChunkHit>>;
    /// Postgres full-text-search candidates over `chunks.fts`
    /// (`websearch_to_tsquery`), tenant-scoped; `score` is `ts_rank`. The
    /// local, key-free lexical leg of hybrid retrieval, fused with `knn_search`
    /// by RRF in [`crate::retrieve`].
    async fn fts_search(
        &self,
        tenant_id: Uuid,
        query: &str,
        k: i64,
        filter: Option<&ChunkFilter>,
    ) -> anyhow::Result<Vec<ChunkHit>>;
    async fn delete_chunks_for_block(&self, tenant_id: Uuid, block_id: Uuid)
        -> anyhow::Result<u64>;
}

/// Postgres/pgvector-backed [`VectorStore`].
#[derive(Clone)]
pub struct PgVectorStore {
    pool: PgPool,
    /// Whether the server's pgvector supports `hnsw.iterative_scan`
    /// (pgvector >= 0.8). Probed once, then cached for the process lifetime.
    iterative_scan: Arc<OnceLock<bool>>,
}

impl PgVectorStore {
    pub fn new(pool: PgPool) -> Self {
        Self {
            pool,
            iterative_scan: Arc::new(OnceLock::new()),
        }
    }

    /// `true` when the installed pgvector version is >= 0.8, i.e. supports
    /// `hnsw.iterative_scan`. Result is cached; a lost race just repeats the
    /// cheap catalog query.
    async fn iterative_scan_supported(
        &self,
        tx: &mut Transaction<'_, Postgres>,
    ) -> anyhow::Result<bool> {
        if let Some(v) = self.iterative_scan.get() {
            return Ok(*v);
        }
        let version: Option<String> =
            sqlx::query_scalar("SELECT extversion FROM pg_extension WHERE extname = 'vector'")
                .fetch_optional(&mut **tx)
                .await
                .context("querying pgvector extension version")?;
        let supported = version.as_deref().is_some_and(|v| {
            let mut parts = v.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
            let major = parts.next().unwrap_or(0);
            let minor = parts.next().unwrap_or(0);
            (major, minor) >= (0, 8)
        });
        Ok(*self.iterative_scan.get_or_init(|| supported))
    }
}

impl VectorStore for PgVectorStore {
    async fn upsert_chunks(
        &self,
        tenant_id: Uuid,
        chunks: &[NewChunk],
    ) -> anyhow::Result<Vec<Uuid>> {
        let mut tx = self.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;
        let mut ids = Vec::with_capacity(chunks.len());
        for chunk in chunks {
            anyhow::ensure!(
                chunk.vector.len() == CHUNK_DIM,
                "chunk vector must be {CHUNK_DIM}-dim, got {}",
                chunk.vector.len()
            );
            let id = chunk.id.unwrap_or_else(Uuid::new_v4);
            // The conflict update is explicitly tenant-scoped so a caller-
            // supplied id owned by another tenant surfaces as a clear domain
            // error (rows_affected == 0) instead of an opaque RLS violation.
            let result = sqlx::query(
                "INSERT INTO chunks (id, tenant_id, vector, text, contextual_prefix, block_id, \
                 topic, system_tags, source_type, date) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) \
                 ON CONFLICT (id) DO UPDATE SET \
                   vector = EXCLUDED.vector, \
                   text = EXCLUDED.text, \
                   contextual_prefix = EXCLUDED.contextual_prefix, \
                   block_id = EXCLUDED.block_id, \
                   topic = EXCLUDED.topic, \
                   system_tags = EXCLUDED.system_tags, \
                   source_type = EXCLUDED.source_type, \
                   date = EXCLUDED.date \
                 WHERE chunks.tenant_id = EXCLUDED.tenant_id",
            )
            .bind(id)
            .bind(tenant_id)
            .bind(Vector::from(chunk.vector.clone()))
            .bind(&chunk.text)
            .bind(&chunk.contextual_prefix)
            .bind(chunk.block_id)
            .bind(&chunk.topic)
            .bind(&chunk.system_tags)
            .bind(&chunk.source_type)
            .bind(chunk.date)
            .execute(&mut *tx)
            .await
            .context("upsert chunk")?;
            anyhow::ensure!(
                result.rows_affected() == 1,
                "chunk id {id} already exists and is owned by another tenant"
            );
            ids.push(id);
        }
        tx.commit().await?;
        Ok(ids)
    }

    async fn knn_search(
        &self,
        tenant_id: Uuid,
        query_vec: &[f32],
        k: i64,
        filter: Option<&ChunkFilter>,
    ) -> anyhow::Result<Vec<ChunkHit>> {
        anyhow::ensure!(
            query_vec.len() == CHUNK_DIM,
            "query vector must be {CHUNK_DIM}-dim, got {}",
            query_vec.len()
        );
        let (source_type, topic) = match filter {
            Some(f) => (f.source_type.clone(), f.topic.clone()),
            None => (None, None),
        };

        let mut tx = self.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;

        // Recall guard: the HNSW scan yields the GLOBAL top-`hnsw.ef_search`
        // candidates by distance; the RLS tenant predicate and the $2/$3
        // metadata filters are applied as post-filters. In a shared
        // multi-tenant table a small tenant whose vectors are outside the
        // global top-N would get fewer than k (even zero) hits. Iterative
        // scanning (pgvector >= 0.8; the pinned pgvector/pgvector:pg16 image
        // ships it) keeps scanning until enough rows survive the filters;
        // a raised ef_search widens each round. SET LOCAL scopes both to
        // this transaction. SET cannot take bind parameters — ef_search is a
        // server-clamped integer computed here, never caller text.
        if self.iterative_scan_supported(&mut tx).await? {
            sqlx::query("SET LOCAL hnsw.iterative_scan = relaxed_order")
                .execute(&mut *tx)
                .await
                .context("enabling hnsw iterative scan")?;
        }
        let ef_search = (k.saturating_mul(4)).clamp(40, 1000);
        sqlx::query(&format!("SET LOCAL hnsw.ef_search = {ef_search}"))
            .execute(&mut *tx)
            .await
            .context("raising hnsw.ef_search")?;

        // Always-bound optional filters keep this a single prepared statement.
        let rows: Vec<KnnRow> = sqlx::query_as(
            "SELECT id, text, contextual_prefix, block_id, topic, \
                    (vector <=> $1)::float8 AS distance \
             FROM chunks \
             WHERE vector IS NOT NULL \
               AND ($2::text IS NULL OR source_type = $2) \
               AND ($3::text IS NULL OR topic = $3) \
             ORDER BY vector <=> $1 \
             LIMIT $4",
        )
        .bind(Vector::from(query_vec.to_vec()))
        .bind(source_type)
        .bind(topic)
        .bind(k)
        .fetch_all(&mut *tx)
        .await
        .context("knn search")?;
        tx.commit().await?;

        Ok(rows
            .into_iter()
            .map(|row| ChunkHit {
                id: row.id,
                text: row.text,
                contextual_prefix: row.contextual_prefix,
                block_id: row.block_id,
                topic: row.topic,
                score: 1.0 - row.distance,
            })
            .collect())
    }

    async fn fts_search(
        &self,
        tenant_id: Uuid,
        query: &str,
        k: i64,
        filter: Option<&ChunkFilter>,
    ) -> anyhow::Result<Vec<ChunkHit>> {
        let (source_type, topic) = match filter {
            Some(f) => (f.source_type.clone(), f.topic.clone()),
            None => (None, None),
        };

        let mut tx = self.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;

        // websearch_to_tsquery parses user-friendly query syntax (quoted
        // phrases, OR, -exclusion) safely — it never errors on arbitrary
        // input, so no query pre-sanitization is needed. The @@ match uses the
        // GIN index on chunks.fts; ts_rank scores the surviving rows. RLS
        // scopes to the tenant; $2/$3 are always-bound optional filters.
        let rows: Vec<FtsRow> = sqlx::query_as(
            "SELECT id, text, contextual_prefix, block_id, topic, \
                    ts_rank(fts, websearch_to_tsquery('english', $1))::float8 AS rank \
             FROM chunks \
             WHERE fts @@ websearch_to_tsquery('english', $1) \
               AND ($2::text IS NULL OR source_type = $2) \
               AND ($3::text IS NULL OR topic = $3) \
             ORDER BY rank DESC \
             LIMIT $4",
        )
        .bind(query)
        .bind(source_type)
        .bind(topic)
        .bind(k)
        .fetch_all(&mut *tx)
        .await
        .context("fts search")?;
        tx.commit().await?;

        Ok(rows
            .into_iter()
            .map(|row| ChunkHit {
                id: row.id,
                text: row.text,
                contextual_prefix: row.contextual_prefix,
                block_id: row.block_id,
                topic: row.topic,
                score: row.rank,
            })
            .collect())
    }

    async fn delete_chunks_for_block(
        &self,
        tenant_id: Uuid,
        block_id: Uuid,
    ) -> anyhow::Result<u64> {
        let mut tx = self.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;
        let result = sqlx::query("DELETE FROM chunks WHERE block_id = $1")
            .bind(block_id)
            .execute(&mut *tx)
            .await
            .context("delete chunks for block")?;
        tx.commit().await?;
        Ok(result.rows_affected())
    }
}
