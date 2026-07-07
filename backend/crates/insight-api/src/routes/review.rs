//! Governance review queue: list conflicts/novelties awaiting a decision, and
//! resolve them. Shapes match the api-client (`ReviewItem` + resolution).

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::AuthedUser;
use crate::error::ApiError;
use crate::state::AppState;
use insight_core::storage::set_tenant;

fn review_type(reason: &Option<String>) -> &'static str {
    match reason.as_deref() {
        Some("contradiction") | Some("conflict") => "conflict",
        _ => "new",
    }
}

fn review_status(s: &str) -> &'static str {
    match s {
        "accepted" | "resolved" => "accepted",
        "rejected" => "rejected",
        _ => "pending",
    }
}

#[derive(sqlx::FromRow)]
struct ReviewRow {
    id: Uuid,
    reason: Option<String>,
    status: String,
    claim_text: Option<String>,
    canonical_topic: Option<String>,
}

fn review_json(r: &ReviewRow) -> Value {
    json!({
        "id": r.id,
        "topic": r.canonical_topic.clone().unwrap_or_default(),
        "type": review_type(&r.reason),
        "status": review_status(&r.status),
        "originalClaim": null,
        "newClaim": r.claim_text.clone().unwrap_or_default(),
        "sourceA": null,
        "sourceB": "",
        "confidence": "0.5",
        "notes": r.reason.clone().unwrap_or_default(),
    })
}

/// `GET /api/review` → `{ items, total }` (client unwraps).
pub async fn list_review(
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
    let rows: Vec<ReviewRow> = sqlx::query_as(
        "SELECT r.id, r.reason, r.status, c.claim_text, c.canonical_topic \
         FROM review_queue r \
         LEFT JOIN claims c ON c.id = r.ref_id AND r.ref_kind = 'claim' \
         WHERE r.status = 'open' ORDER BY r.id DESC LIMIT 200",
    )
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    let items: Vec<Value> = rows.iter().map(review_json).collect();
    let total = items.len();
    Ok(Json(json!({ "items": items, "total": total })))
}

#[derive(Debug, Deserialize)]
pub struct ResolveBody {
    decision: String,
}

/// `POST /api/review/{id}` → the resolved `ReviewItem` + resolution.
pub async fn resolve_review(
    State(state): State<AppState>,
    user: AuthedUser,
    Path(id): Path<Uuid>,
    Json(body): Json<ResolveBody>,
) -> Result<Json<Value>, ApiError> {
    if body.decision != "accepted" && body.decision != "rejected" {
        return Err(ApiError::bad_request(
            "decision must be accepted or rejected",
        ));
    }
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    // Resolve the queue row and settle the underlying claim.
    let row: Option<ReviewRow> = sqlx::query_as(
        "UPDATE review_queue SET status = $2 WHERE id = $1 AND status = 'open' \
         RETURNING id, reason, status, \
                   (SELECT claim_text FROM claims WHERE id = review_queue.ref_id) AS claim_text, \
                   (SELECT canonical_topic FROM claims WHERE id = review_queue.ref_id) AS canonical_topic",
    )
    .bind(id)
    .bind(&body.decision)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    let Some(row) = row else {
        tx.commit().await.ok();
        return Err(ApiError::not_found("review item not found"));
    };

    // Settle the claim: accepted → active, rejected → retired.
    let claim_status = if body.decision == "accepted" {
        "active"
    } else {
        "retired"
    };
    sqlx::query(
        "UPDATE claims SET status = $2 \
         WHERE id = (SELECT ref_id FROM review_queue WHERE id = $1)",
    )
    .bind(id)
    .bind(claim_status)
    .execute(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;

    let mut item = review_json(&row);
    item["resolution"] = json!({
        "resolved": true,
        "winnerClaimId": null,
        "loserClaimId": null,
        "detail": format!("marked {}", body.decision),
    });
    Ok(Json(item))
}
