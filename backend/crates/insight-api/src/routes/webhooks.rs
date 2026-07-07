//! Webhook endpoints registry + test delivery. Writes require `admin`. Shapes
//! match the api-client (`WebhookEndpoint`, `WebhookTestResult`).

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use chrono::SecondsFormat;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::{AuthedUser, RequireAdmin};
use crate::error::ApiError;
use crate::state::AppState;
use insight_core::security;
use insight_core::storage::set_tenant;
use insight_core::webhooks;

#[derive(sqlx::FromRow)]
struct HookRow {
    id: Uuid,
    url: String,
    event: String,
    active: bool,
    secret: Option<String>,
    last_delivery_at: Option<chrono::DateTime<chrono::Utc>>,
    last_status: Option<String>,
    created_at: chrono::DateTime<chrono::Utc>,
}

fn hook_json(h: &HookRow) -> Value {
    json!({
        "id": h.id,
        "url": h.url,
        "event": h.event,
        "active": h.active,
        "createdAt": h.created_at.to_rfc3339_opts(SecondsFormat::Millis, true),
        "secretSet": h.secret.is_some(),
        "lastDeliveryAt": h.last_delivery_at.map(|d| d.to_rfc3339_opts(SecondsFormat::Millis, true)),
        "lastStatus": h.last_status,
    })
}

const SELECT: &str =
    "SELECT id, url, event, active, secret, last_delivery_at, last_status, created_at FROM webhooks";

fn valid_url(u: &str) -> bool {
    u.starts_with("http://") || u.starts_with("https://")
}

/// `GET /api/webhooks` → `{ items, total, events }`.
pub async fn list_webhooks(
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
    let rows: Vec<HookRow> = sqlx::query_as(&format!("{SELECT} ORDER BY created_at DESC"))
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    let items: Vec<Value> = rows.iter().map(hook_json).collect();
    let total = items.len();
    Ok(Json(
        json!({ "items": items, "total": total, "events": webhooks::WEBHOOK_EVENTS }),
    ))
}

#[derive(Debug, Deserialize)]
pub struct CreateBody {
    url: String,
    event: Option<String>,
}

/// `POST /api/webhooks` (admin) → created hook with its one-time secret.
pub async fn create_webhook(
    State(state): State<AppState>,
    RequireAdmin(user): RequireAdmin,
    Json(body): Json<CreateBody>,
) -> Result<Json<Value>, ApiError> {
    if body.url.trim().is_empty() {
        return Err(ApiError::bad_request("url required"));
    }
    if !valid_url(&body.url) {
        return Err(ApiError::bad_request("url must be a valid http(s) URL"));
    }
    let event = body
        .event
        .map(|e| e.trim().to_string())
        .filter(|e| !e.is_empty())
        .unwrap_or_else(|| "*".into());
    let secret = security::generate_webhook_secret();
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO webhooks (tenant_id, url, event, secret) VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(user.tenant_id)
    .bind(&body.url)
    .bind(&event)
    .bind(&secret)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(Json(json!({
        "id": id, "url": body.url, "event": event, "active": true,
        "secret": secret, "signing": "hmac-sha256",
    })))
}

#[derive(Debug, Deserialize)]
pub struct PatchBody {
    url: Option<String>,
    event: Option<String>,
    active: Option<bool>,
}

/// `PATCH /api/webhooks/{id}` (admin).
pub async fn update_webhook(
    State(state): State<AppState>,
    RequireAdmin(user): RequireAdmin,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchBody>,
) -> Result<Json<Value>, ApiError> {
    if body.url.is_none() && body.event.is_none() && body.active.is_none() {
        return Err(ApiError::bad_request(
            "nothing to update (url, event, active)",
        ));
    }
    if let Some(u) = &body.url {
        if !valid_url(u) {
            return Err(ApiError::bad_request("url must be a valid http(s) URL"));
        }
    }
    let event = body.event.map(|e| {
        let t = e.trim().to_string();
        if t.is_empty() {
            "*".into()
        } else {
            t
        }
    });
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let row: Option<HookRow> = sqlx::query_as(
        "UPDATE webhooks SET url = COALESCE($2, url), event = COALESCE($3, event), \
                active = COALESCE($4, active) WHERE id = $1 \
         RETURNING id, url, event, active, secret, last_delivery_at, last_status, created_at",
    )
    .bind(id)
    .bind(body.url.as_deref())
    .bind(event.as_deref())
    .bind(body.active)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    let row = row.ok_or_else(|| ApiError::not_found("webhook not found"))?;
    Ok(Json(hook_json(&row)))
}

/// `POST /api/webhooks/{id}/test` (admin) → `WebhookTestResult`.
pub async fn test_webhook(
    State(state): State<AppState>,
    RequireAdmin(user): RequireAdmin,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let hook: Option<HookRow> = sqlx::query_as(&format!("{SELECT} WHERE id = $1"))
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    let hook = hook.ok_or_else(|| ApiError::not_found("webhook not found"))?;

    let payload = json!({ "message": "test event from Insight Library", "webhookId": id });
    let d =
        webhooks::deliver_one(&hook.url, hook.secret.as_deref(), "webhook.test", &payload).await;

    // Record the outcome.
    let status = d.error.clone().unwrap_or_else(|| d.status.to_string());
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let _ =
        sqlx::query("UPDATE webhooks SET last_delivery_at = now(), last_status = $2 WHERE id = $1")
            .bind(id)
            .bind(&status)
            .execute(&mut *tx)
            .await;
    tx.commit().await.ok();

    Ok(Json(json!({
        "ok": d.error.is_none(),
        "status": d.status,
        "statusText": d.status_text,
        "durationMs": d.duration_ms,
        "signed": d.signed,
        "error": d.error,
    })))
}

/// `DELETE /api/webhooks/{id}` (admin).
pub async fn delete_webhook(
    State(state): State<AppState>,
    RequireAdmin(user): RequireAdmin,
    Path(id): Path<Uuid>,
) -> Result<axum::response::Response, ApiError> {
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    sqlx::query("DELETE FROM webhooks WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok((StatusCode::OK, Json(json!({ "ok": true }))).into_response())
}
