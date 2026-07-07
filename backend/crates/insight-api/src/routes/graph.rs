//! Knowledge graph endpoints. Shapes match the api-client (`Graph`,
//! communities, community detail, pagerank, `GraphStats`).

use std::collections::HashMap;

use axum::extract::{Path, State};
use axum::Json;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::AuthedUser;
use crate::error::ApiError;
use crate::state::AppState;
use insight_core::graph as kg;
use insight_core::storage::set_tenant;

const GRAPH_LIMIT: i64 = 500;

/// `GET /api/graph` → `{ nodes, edges }`.
pub async fn get_graph(
    State(state): State<AppState>,
    user: AuthedUser,
) -> Result<Json<Value>, ApiError> {
    let (nodes, edges) = kg::load_graph(&state.stores, user.tenant_id, GRAPH_LIMIT)
        .await
        .map_err(ApiError::from)?;
    let nodes_json: Vec<Value> = nodes
        .iter()
        .map(
            |n| json!({ "id": n.id, "group": n.kind, "size": 1, "kind": n.kind, "label": n.label }),
        )
        .collect();
    let edges_json: Vec<Value> = edges
        .iter()
        .map(|e| json!({ "source": e.src, "target": e.dst, "label": e.rel, "rel": e.rel, "weight": e.weight }))
        .collect();
    Ok(Json(json!({ "nodes": nodes_json, "edges": edges_json })))
}

async fn node_labels(state: &AppState, tenant_id: Uuid) -> Result<HashMap<Uuid, String>, ApiError> {
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, tenant_id).await?;
    let rows: Vec<(Uuid, String)> = sqlx::query_as("SELECT id, label FROM nodes")
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(rows.into_iter().collect())
}

/// `GET /api/graph/communities` → `{ items, total }` (client unwraps).
pub async fn get_communities(
    State(state): State<AppState>,
    user: AuthedUser,
) -> Result<Json<Value>, ApiError> {
    let (labels, _) = kg::community_labels(&state.stores, user.tenant_id)
        .await
        .map_err(ApiError::from)?;
    let names = node_labels(&state, user.tenant_id).await?;
    let mut groups: HashMap<usize, Vec<Uuid>> = HashMap::new();
    for (node, community) in &labels {
        groups.entry(*community).or_default().push(*node);
    }
    let items: Vec<Value> = groups
        .into_iter()
        .map(|(cid, node_ids)| {
            let label = node_ids
                .first()
                .and_then(|n| names.get(n).cloned())
                .unwrap_or_else(|| format!("community {cid}"));
            json!({
                "id": format!("c{cid}"),
                "label": label,
                "size": node_ids.len(),
                "nodeIds": node_ids,
            })
        })
        .collect();
    let total = items.len();
    Ok(Json(json!({ "items": items, "total": total })))
}

/// `GET /api/graph/community/{nodeId}` → `{ label, nodes, edges, summary? }`.
pub async fn get_community(
    State(state): State<AppState>,
    user: AuthedUser,
    Path(node_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let (labels, _) = kg::community_labels(&state.stores, user.tenant_id)
        .await
        .map_err(ApiError::from)?;
    let community = labels
        .get(&node_id)
        .copied()
        .ok_or_else(|| ApiError::not_found("node not in graph"))?;
    let members: std::collections::HashSet<Uuid> = labels
        .iter()
        .filter(|(_, c)| **c == community)
        .map(|(n, _)| *n)
        .collect();
    let names = node_labels(&state, user.tenant_id).await?;

    // Edges within the community.
    let (_, edges) = kg::load_graph(&state.stores, user.tenant_id, GRAPH_LIMIT)
        .await
        .map_err(ApiError::from)?;
    let nodes: Vec<Value> = members
        .iter()
        .map(|n| json!({ "id": n, "label": names.get(n).cloned().unwrap_or_default() }))
        .collect();
    let edge_json: Vec<Value> = edges
        .iter()
        .filter(|e| members.contains(&e.src) && members.contains(&e.dst))
        .map(|e| json!({ "source": e.src, "target": e.dst, "label": e.rel }))
        .collect();
    let label = names.get(&node_id).cloned().unwrap_or_default();
    Ok(Json(
        json!({ "label": label, "nodes": nodes, "edges": edge_json }),
    ))
}

/// `GET /api/graph/pagerank` → `{ items, total }` (client unwraps), top 30.
pub async fn get_pagerank(
    State(state): State<AppState>,
    user: AuthedUser,
) -> Result<Json<Value>, ApiError> {
    let scored = kg::pagerank(&state.stores, user.tenant_id)
        .await
        .map_err(ApiError::from)?;
    let items: Vec<Value> = scored
        .iter()
        .take(30)
        .map(|(id, label, score)| json!({ "id": id, "label": label, "score": score }))
        .collect();
    let total = items.len();
    Ok(Json(json!({ "items": items, "total": total })))
}

/// `GET /api/graph/stats` → `GraphStats`.
pub async fn get_stats(
    State(state): State<AppState>,
    user: AuthedUser,
) -> Result<Json<Value>, ApiError> {
    let s = kg::stats(&state.stores, user.tenant_id)
        .await
        .map_err(ApiError::from)?;
    // groups: count nodes by kind.
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let groups: Vec<(String, i64)> = sqlx::query_as(
        "SELECT kind, count(*) FROM nodes GROUP BY kind ORDER BY count(*) DESC LIMIT 10",
    )
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    let groups_json: Vec<Value> = groups
        .iter()
        .map(|(g, c)| json!({ "group": g, "count": c }))
        .collect();
    Ok(Json(json!({
        "source": "postgres",
        "nodes": s.nodes,
        "edges": s.edges,
        "communities": s.communities,
        "groups": groups_json,
    })))
}
