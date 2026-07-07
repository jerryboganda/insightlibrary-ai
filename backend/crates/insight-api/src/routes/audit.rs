//! Audit log viewer (paged + filtered). Shape matches the api-client `AuditLog`.

use axum::extract::{Query, State};
use axum::Json;
use chrono::SecondsFormat;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::AuthedUser;
use crate::error::ApiError;
use crate::state::AppState;
use insight_core::storage::set_tenant;

#[derive(Debug, Deserialize)]
pub struct AuditQuery {
    limit: Option<i64>,
    offset: Option<i64>,
    from: Option<String>,
    to: Option<String>,
    action: Option<String>,
    actor: Option<String>,
    severity: Option<String>,
}

#[derive(sqlx::FromRow)]
struct AuditRow {
    id: Uuid,
    actor: String,
    action: String,
    target: String,
    severity: String,
    created_at: chrono::DateTime<chrono::Utc>,
}

/// `GET /api/audit` → `{ items, total, limit, offset }`.
pub async fn list_audit(
    State(state): State<AppState>,
    user: AuthedUser,
    Query(q): Query<AuditQuery>,
) -> Result<Json<Value>, ApiError> {
    let limit = q.limit.unwrap_or(200).clamp(1, 500);
    let offset = q.offset.unwrap_or(0).max(0);
    let severity = q
        .severity
        .filter(|s| matches!(s.as_str(), "info" | "warning" | "critical"));
    let action = q.action.map(|a| format!("%{}%", a));
    let actor = q.actor.map(|a| format!("%{}%", a));
    let from = q.from.and_then(|s| {
        chrono::DateTime::parse_from_rfc3339(&s)
            .ok()
            .map(|d| d.with_timezone(&chrono::Utc))
    });
    let to = q.to.and_then(|s| {
        chrono::DateTime::parse_from_rfc3339(&s)
            .ok()
            .map(|d| d.with_timezone(&chrono::Utc))
    });

    // Shared filter over $1..$5 (from, to, action, actor, severity).
    let filter = "($1::timestamptz IS NULL OR created_at >= $1) \
         AND ($2::timestamptz IS NULL OR created_at <= $2) \
         AND ($3::text IS NULL OR action ILIKE $3) \
         AND ($4::text IS NULL OR actor ILIKE $4) \
         AND ($5::text IS NULL OR severity = $5)";

    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let rows: Vec<AuditRow> = sqlx::query_as(&format!(
        "SELECT id, actor, action, target, severity, created_at FROM audit_logs WHERE {filter} \
         ORDER BY created_at DESC LIMIT $6 OFFSET $7"
    ))
    .bind(from)
    .bind(to)
    .bind(&action)
    .bind(&actor)
    .bind(&severity)
    .bind(limit)
    .bind(offset)
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    let total: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM audit_logs WHERE {filter}"))
        .bind(from)
        .bind(to)
        .bind(&action)
        .bind(&actor)
        .bind(&severity)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;

    let items: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.id,
                "actor": r.actor,
                "action": r.action,
                "target": r.target,
                "timestamp": r.created_at.to_rfc3339_opts(SecondsFormat::Millis, true),
                "severity": r.severity,
            })
        })
        .collect();
    Ok(Json(
        json!({ "items": items, "total": total, "limit": limit, "offset": offset }),
    ))
}
