//! Webhook dispatch (Phase 12): match subscriptions by event pattern and POST a
//! signed (HMAC-SHA256) JSON payload, recording the last delivery status.

use std::time::{Duration, Instant};

use anyhow::Context;
use serde_json::Value;
use uuid::Uuid;

use crate::security;
use crate::storage::{set_tenant, Stores};

/// The events a webhook can subscribe to (also surfaced to the UI selector).
pub const WEBHOOK_EVENTS: &[&str] = &[
    "document.indexed",
    "document.failed",
    "conflict.detected",
    "review.resolved",
];

/// `true` when `pattern` (a webhook's `event`) matches `event`: `*`/empty = all,
/// exact match, or a `category.*` prefix.
pub fn matches_event(pattern: &str, event: &str) -> bool {
    let p = pattern.trim();
    if p.is_empty() || p == "*" {
        return true;
    }
    if let Some(prefix) = p.strip_suffix(".*") {
        return event
            .split_once('.')
            .map(|(cat, _)| cat == prefix)
            .unwrap_or(false);
    }
    p == event
}

/// Result of one delivery attempt.
pub struct Delivery {
    pub status: i64,
    pub status_text: String,
    pub duration_ms: u64,
    pub signed: bool,
    pub error: Option<String>,
}

/// POST a signed payload to `url`. Never returns an error — transport failures
/// are captured in `Delivery.error` with status 0.
pub async fn deliver_one(
    url: &str,
    secret: Option<&str>,
    event: &str,
    payload: &Value,
) -> Delivery {
    let body = serde_json::json!({ "event": event, "data": payload }).to_string();
    let signed = secret.is_some();
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return Delivery {
                status: 0,
                status_text: "client error".into(),
                duration_ms: 0,
                signed,
                error: Some(format!("{e}")),
            }
        }
    };
    let mut req = client
        .post(url)
        .header("content-type", "application/json")
        .header("x-insight-event", event);
    if let Some(secret) = secret {
        let sig = security::hmac_sha256_hex(secret, &body);
        req = req.header("x-insight-signature", format!("sha256={sig}"));
    }
    let start = Instant::now();
    match req.body(body).send().await {
        Ok(resp) => {
            let status = resp.status();
            Delivery {
                status: status.as_u16() as i64,
                status_text: status.canonical_reason().unwrap_or("").to_string(),
                duration_ms: start.elapsed().as_millis() as u64,
                signed,
                error: if status.is_success() {
                    None
                } else {
                    Some(format!("http {status}"))
                },
            }
        }
        Err(e) => Delivery {
            status: 0,
            status_text: "error".into(),
            duration_ms: start.elapsed().as_millis() as u64,
            signed,
            error: Some(format!("{e}")),
        },
    }
}

/// Record a delivery outcome on the webhook row.
async fn record(stores: &Stores, tenant_id: Uuid, webhook_id: Uuid, status: &str) {
    if let Ok(mut tx) = stores.pool.begin().await {
        if set_tenant(&mut tx, tenant_id).await.is_ok() {
            let _ = sqlx::query(
                "UPDATE webhooks SET last_delivery_at = now(), last_status = $2 WHERE id = $1",
            )
            .bind(webhook_id)
            .bind(status)
            .execute(&mut *tx)
            .await;
            let _ = tx.commit().await;
        }
    }
}

/// Dispatch an event to every active, matching webhook in a tenant.
pub async fn dispatch(
    stores: &Stores,
    tenant_id: Uuid,
    event: &str,
    payload: &Value,
) -> anyhow::Result<usize> {
    let hooks: Vec<(Uuid, String, String, Option<String>)> = {
        let mut tx = stores.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;
        let rows = sqlx::query_as("SELECT id, url, event, secret FROM webhooks WHERE active")
            .fetch_all(&mut *tx)
            .await
            .context("load webhooks")?;
        tx.commit().await?;
        rows
    };
    let mut delivered = 0usize;
    for (id, url, pattern, secret) in hooks {
        if !matches_event(&pattern, event) {
            continue;
        }
        let d = deliver_one(&url, secret.as_deref(), event, payload).await;
        let status = if let Some(err) = &d.error {
            err.clone()
        } else {
            d.status.to_string()
        };
        record(stores, tenant_id, id, &status).await;
        delivered += 1;
    }
    Ok(delivered)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_patterns() {
        assert!(matches_event("*", "document.indexed"));
        assert!(matches_event("", "anything"));
        assert!(matches_event("document.indexed", "document.indexed"));
        assert!(!matches_event("document.indexed", "document.failed"));
        assert!(matches_event("document.*", "document.failed"));
        assert!(!matches_event("document.*", "review.resolved"));
    }
}
