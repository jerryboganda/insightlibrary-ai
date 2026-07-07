//! Knowledge graph (Phase 10): build a concept co-occurrence graph from grounded
//! claims, and compute communities (connected components) + PageRank. `nodes` /
//! `edges` are derived data, rebuilt wholesale each pass.

use std::collections::HashMap;

use anyhow::Context;
use uuid::Uuid;

use crate::storage::{set_tenant, Stores};

/// Node/edge/community counts for the stats endpoint.
#[derive(Debug, Default, Clone)]
pub struct GraphStats {
    pub nodes: i64,
    pub edges: i64,
    pub communities: i64,
}

/// A graph node in API form.
#[derive(Debug, Clone)]
pub struct GraphNode {
    pub id: Uuid,
    pub label: String,
    pub kind: String,
}

/// A graph edge in API form.
#[derive(Debug, Clone)]
pub struct GraphEdge {
    pub src: Uuid,
    pub dst: Uuid,
    pub rel: String,
    pub weight: f32,
}

/// Rebuild the tenant's concept graph from grounded claims. Nodes are distinct
/// grounded concepts; edges connect concepts that co-occur in the same document.
pub async fn build_graph(stores: &Stores, tenant_id: Uuid) -> anyhow::Result<GraphStats> {
    let mut tx = stores.pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;

    // Wipe derived graph for this tenant (edges first for FK order).
    sqlx::query("DELETE FROM edges")
        .execute(&mut *tx)
        .await
        .context("clear edges")?;
    sqlx::query("DELETE FROM nodes")
        .execute(&mut *tx)
        .await
        .context("clear nodes")?;

    // Distinct grounded concepts (concept id + a display label).
    let concepts: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT DISTINCT canonical_concept_id, \
                COALESCE(canonical_topic, '(concept)') AS label \
         FROM claims WHERE canonical_concept_id IS NOT NULL",
    )
    .fetch_all(&mut *tx)
    .await
    .context("distinct grounded concepts")?;

    // Insert a node per concept; map concept_id -> node_id.
    let mut node_of: HashMap<Uuid, Uuid> = HashMap::new();
    for (concept_id, label) in &concepts {
        let node_id: Uuid = sqlx::query_scalar(
            "INSERT INTO nodes (tenant_id, kind, label, canonical_concept_id) \
             VALUES ($1, 'concept', $2, $3) RETURNING id",
        )
        .bind(tenant_id)
        .bind(label)
        .bind(concept_id)
        .fetch_one(&mut *tx)
        .await
        .context("insert graph node")?;
        node_of.insert(*concept_id, node_id);
    }

    // Co-occurrence: concept pairs appearing in claims from the same document.
    let pairs: Vec<(Uuid, Uuid, i64)> = sqlx::query_as(
        "SELECT a.canonical_concept_id AS c1, b.canonical_concept_id AS c2, count(*) AS n \
         FROM claims a \
         JOIN claim_sources sa ON sa.claim_id = a.id \
         JOIN claim_sources sb ON sb.document_id = sa.document_id \
         JOIN claims b ON b.id = sb.claim_id \
         WHERE a.canonical_concept_id IS NOT NULL AND b.canonical_concept_id IS NOT NULL \
           AND a.canonical_concept_id < b.canonical_concept_id \
         GROUP BY 1, 2",
    )
    .fetch_all(&mut *tx)
    .await
    .context("concept co-occurrence")?;

    let mut edge_count = 0i64;
    for (c1, c2, n) in &pairs {
        let (Some(&src), Some(&dst)) = (node_of.get(c1), node_of.get(c2)) else {
            continue;
        };
        sqlx::query(
            "INSERT INTO edges (tenant_id, src_id, dst_id, rel, weight) \
             VALUES ($1, $2, $3, 'co_occurs', $4) \
             ON CONFLICT (tenant_id, src_id, dst_id, rel) DO UPDATE SET weight = $4",
        )
        .bind(tenant_id)
        .bind(src)
        .bind(dst)
        .bind(*n as f32)
        .execute(&mut *tx)
        .await
        .context("insert graph edge")?;
        edge_count += 1;
    }
    tx.commit().await?;

    let communities = community_labels(stores, tenant_id).await?.1;
    Ok(GraphStats {
        nodes: node_of.len() as i64,
        edges: edge_count,
        communities,
    })
}

/// Load the tenant's graph (nodes + edges), capped for rendering.
pub async fn load_graph(
    stores: &Stores,
    tenant_id: Uuid,
    limit: i64,
) -> anyhow::Result<(Vec<GraphNode>, Vec<GraphEdge>)> {
    let mut tx = stores.pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    let nodes: Vec<GraphNode> = sqlx::query_as::<_, (Uuid, String, String)>(
        "SELECT id, label, kind FROM nodes ORDER BY label LIMIT $1",
    )
    .bind(limit)
    .fetch_all(&mut *tx)
    .await
    .context("load nodes")?
    .into_iter()
    .map(|(id, label, kind)| GraphNode { id, label, kind })
    .collect();
    let edges: Vec<GraphEdge> = sqlx::query_as::<_, (Uuid, Uuid, String, f32)>(
        "SELECT src_id, dst_id, rel, weight FROM edges LIMIT $1",
    )
    .bind(limit * 4)
    .fetch_all(&mut *tx)
    .await
    .context("load edges")?
    .into_iter()
    .map(|(src, dst, rel, weight)| GraphEdge {
        src,
        dst,
        rel,
        weight,
    })
    .collect();
    tx.commit().await?;
    Ok((nodes, edges))
}

/// Adjacency (node -> neighbors) for the tenant graph.
async fn adjacency(
    stores: &Stores,
    tenant_id: Uuid,
) -> anyhow::Result<(Vec<Uuid>, HashMap<Uuid, Vec<Uuid>>)> {
    let mut tx = stores.pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    let node_ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM nodes")
        .fetch_all(&mut *tx)
        .await
        .context("node ids")?;
    let edges: Vec<(Uuid, Uuid)> = sqlx::query_as("SELECT src_id, dst_id FROM edges")
        .fetch_all(&mut *tx)
        .await
        .context("edge pairs")?;
    tx.commit().await?;
    let mut adj: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
    for id in &node_ids {
        adj.entry(*id).or_default();
    }
    for (s, d) in edges {
        adj.entry(s).or_default().push(d);
        adj.entry(d).or_default().push(s);
    }
    Ok((node_ids, adj))
}

/// Connected-component community assignment. Returns (node -> community index,
/// community count).
pub async fn community_labels(
    stores: &Stores,
    tenant_id: Uuid,
) -> anyhow::Result<(HashMap<Uuid, usize>, i64)> {
    let (node_ids, adj) = adjacency(stores, tenant_id).await?;
    let index: HashMap<Uuid, usize> = node_ids
        .iter()
        .enumerate()
        .map(|(i, id)| (*id, i))
        .collect();
    let mut parent: Vec<usize> = (0..node_ids.len()).collect();
    fn find(parent: &mut [usize], mut x: usize) -> usize {
        while parent[x] != x {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        x
    }
    for (id, neighbors) in &adj {
        let Some(&a) = index.get(id) else { continue };
        for n in neighbors {
            if let Some(&b) = index.get(n) {
                let (ra, rb) = (find(&mut parent, a), find(&mut parent, b));
                if ra != rb {
                    parent[ra] = rb;
                }
            }
        }
    }
    let mut roots: HashMap<usize, usize> = HashMap::new();
    let mut labels: HashMap<Uuid, usize> = HashMap::new();
    for (id, &i) in &index {
        let r = find(&mut parent, i);
        let next = roots.len();
        let community = *roots.entry(r).or_insert(next);
        labels.insert(*id, community);
    }
    let count = roots.len() as i64;
    Ok((labels, count))
}

/// PageRank scores (power iteration), returned highest-first.
pub async fn pagerank(
    stores: &Stores,
    tenant_id: Uuid,
) -> anyhow::Result<Vec<(Uuid, String, f64)>> {
    let (node_ids, adj) = adjacency(stores, tenant_id).await?;
    let n = node_ids.len();
    if n == 0 {
        return Ok(Vec::new());
    }
    let damping = 0.85;
    let mut rank: HashMap<Uuid, f64> = node_ids.iter().map(|id| (*id, 1.0 / n as f64)).collect();
    for _ in 0..30 {
        let mut next: HashMap<Uuid, f64> = node_ids
            .iter()
            .map(|id| (*id, (1.0 - damping) / n as f64))
            .collect();
        for id in &node_ids {
            let neighbors = &adj[id];
            if neighbors.is_empty() {
                let share = damping * rank[id] / n as f64;
                for t in &node_ids {
                    *next.get_mut(t).unwrap() += share;
                }
            } else {
                let share = damping * rank[id] / neighbors.len() as f64;
                for nb in neighbors {
                    *next.get_mut(nb).unwrap() += share;
                }
            }
        }
        rank = next;
    }

    let mut tx = stores.pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    let labels: HashMap<Uuid, String> =
        sqlx::query_as::<_, (Uuid, String)>("SELECT id, label FROM nodes")
            .fetch_all(&mut *tx)
            .await
            .context("labels for pagerank")?
            .into_iter()
            .collect();
    tx.commit().await?;

    let mut scored: Vec<(Uuid, String, f64)> = rank
        .into_iter()
        .map(|(id, score)| (id, labels.get(&id).cloned().unwrap_or_default(), score))
        .collect();
    scored.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    Ok(scored)
}

/// Node/edge/community counts.
pub async fn stats(stores: &Stores, tenant_id: Uuid) -> anyhow::Result<GraphStats> {
    let mut tx = stores.pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    let (nodes,): (i64,) = sqlx::query_as("SELECT count(*) FROM nodes")
        .fetch_one(&mut *tx)
        .await
        .context("count nodes")?;
    let (edges,): (i64,) = sqlx::query_as("SELECT count(*) FROM edges")
        .fetch_one(&mut *tx)
        .await
        .context("count edges")?;
    tx.commit().await?;
    let communities = community_labels(stores, tenant_id).await?.1;
    Ok(GraphStats {
        nodes,
        edges,
        communities,
    })
}
