//! Knowledge-graph store over Postgres `nodes`/`edges` tables: node/edge
//! upsert and bounded-depth neighborhood expansion via a recursive CTE.
//! Tenant-scoped via RLS.

use anyhow::Context;
use sqlx::PgPool;
use uuid::Uuid;

use super::set_tenant;

/// Node payload for [`GraphStore::upsert_node`].
#[derive(Debug, Clone)]
pub struct NewNode {
    /// Provide to upsert a specific row; `None` generates a fresh id.
    /// A provided id MUST belong to the calling tenant: an id owned by
    /// another tenant fails (RLS policy violation or a clear "owned by
    /// another tenant" error from the tenant-scoped conflict update) —
    /// it never touches the foreign row.
    pub id: Option<Uuid>,
    pub kind: String,
    pub label: String,
    pub canonical_concept_id: Option<Uuid>,
    pub description: Option<String>,
}

/// Node row as stored.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct NodeRow {
    pub id: Uuid,
    pub kind: String,
    pub label: String,
    pub canonical_concept_id: Option<Uuid>,
    pub description: Option<String>,
}

/// Graph persistence + traversal. Native async-fn-in-trait.
#[allow(async_fn_in_trait)]
pub trait GraphStore {
    async fn upsert_node(&self, tenant_id: Uuid, node: &NewNode) -> anyhow::Result<Uuid>;
    #[allow(clippy::too_many_arguments)]
    async fn upsert_edge(
        &self,
        tenant_id: Uuid,
        src_id: Uuid,
        dst_id: Uuid,
        rel: &str,
        weight: f32,
        source_claim_id: Option<Uuid>,
    ) -> anyhow::Result<()>;
    /// All nodes reachable from `node_id` within `depth` hops (undirected),
    /// excluding the start node itself.
    async fn neighbors(
        &self,
        tenant_id: Uuid,
        node_id: Uuid,
        depth: i32,
    ) -> anyhow::Result<Vec<NodeRow>>;
}

/// Postgres-backed [`GraphStore`].
#[derive(Clone)]
pub struct PgGraphStore {
    pool: PgPool,
}

impl PgGraphStore {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

impl GraphStore for PgGraphStore {
    async fn upsert_node(&self, tenant_id: Uuid, node: &NewNode) -> anyhow::Result<Uuid> {
        let mut tx = self.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;
        let id = node.id.unwrap_or_else(Uuid::new_v4);
        // Tenant-scoped conflict update: a caller-supplied id owned by
        // another tenant surfaces as a clear domain error (rows_affected ==
        // 0) instead of an opaque RLS violation.
        let result = sqlx::query(
            "INSERT INTO nodes (id, tenant_id, kind, label, canonical_concept_id, description) \
             VALUES ($1, $2, $3, $4, $5, $6) \
             ON CONFLICT (id) DO UPDATE SET \
               kind = EXCLUDED.kind, \
               label = EXCLUDED.label, \
               canonical_concept_id = EXCLUDED.canonical_concept_id, \
               description = EXCLUDED.description \
             WHERE nodes.tenant_id = EXCLUDED.tenant_id",
        )
        .bind(id)
        .bind(tenant_id)
        .bind(&node.kind)
        .bind(&node.label)
        .bind(node.canonical_concept_id)
        .bind(&node.description)
        .execute(&mut *tx)
        .await
        .context("upsert node")?;
        anyhow::ensure!(
            result.rows_affected() == 1,
            "node id {id} already exists and is owned by another tenant"
        );
        tx.commit().await?;
        Ok(id)
    }

    async fn upsert_edge(
        &self,
        tenant_id: Uuid,
        src_id: Uuid,
        dst_id: Uuid,
        rel: &str,
        weight: f32,
        source_claim_id: Option<Uuid>,
    ) -> anyhow::Result<()> {
        let mut tx = self.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;
        sqlx::query(
            "INSERT INTO edges (tenant_id, src_id, dst_id, rel, weight, source_claim_id) \
             VALUES ($1, $2, $3, $4, $5, $6) \
             ON CONFLICT (tenant_id, src_id, dst_id, rel) DO UPDATE SET \
               weight = EXCLUDED.weight, \
               source_claim_id = EXCLUDED.source_claim_id",
        )
        .bind(tenant_id)
        .bind(src_id)
        .bind(dst_id)
        .bind(rel)
        .bind(weight)
        .bind(source_claim_id)
        .execute(&mut *tx)
        .await
        .context("upsert edge")?;
        tx.commit().await?;
        Ok(())
    }

    async fn neighbors(
        &self,
        tenant_id: Uuid,
        node_id: Uuid,
        depth: i32,
    ) -> anyhow::Result<Vec<NodeRow>> {
        let mut tx = self.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;
        // Undirected walk bounded by `depth`; UNION dedups (node, depth)
        // pairs and the depth bound guarantees termination on cycles.
        let rows: Vec<NodeRow> = sqlx::query_as(
            "WITH RECURSIVE walk(node_id, hop) AS ( \
                 SELECT $1::uuid, 0 \
                 UNION \
                 SELECT CASE WHEN e.src_id = w.node_id THEN e.dst_id ELSE e.src_id END, \
                        w.hop + 1 \
                 FROM edges e \
                 JOIN walk w ON e.src_id = w.node_id OR e.dst_id = w.node_id \
                 WHERE w.hop < $2 \
             ) \
             SELECT n.id, n.kind, n.label, n.canonical_concept_id, n.description \
             FROM nodes n \
             JOIN (SELECT DISTINCT node_id FROM walk) w ON n.id = w.node_id \
             WHERE n.id <> $1 \
             ORDER BY n.label",
        )
        .bind(node_id)
        .bind(depth)
        .fetch_all(&mut *tx)
        .await
        .context("expand neighbors")?;
        tx.commit().await?;
        Ok(rows)
    }
}
