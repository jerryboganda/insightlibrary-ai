//! Billing (Stripe). Degrades gracefully when Stripe is unconfigured
//! (`configured:false`, empty invoices, 503 on checkout/portal). Shapes match
//! the api-client billing methods.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde_json::{json, Value};

use crate::auth::{AuthedUser, RequireAdmin};
use crate::error::ApiError;
use crate::state::AppState;
use insight_core::billing;
use insight_core::security;

fn stripe_key() -> Option<String> {
    std::env::var("STRIPE_SECRET_KEY")
        .ok()
        .filter(|k| !k.trim().is_empty())
}

fn web_origin() -> String {
    std::env::var("WEB_ORIGIN").unwrap_or_else(|_| "https://insightai.polytronx.com".into())
}

/// POST form-encoded params to the Stripe API.
async fn stripe_post(key: &str, path: &str, params: &[(&str, String)]) -> anyhow::Result<Value> {
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("https://api.stripe.com/v1/{path}"))
        .bearer_auth(key)
        .form(params)
        .send()
        .await?;
    anyhow::ensure!(
        resp.status().is_success(),
        "stripe returned {}",
        resp.status()
    );
    Ok(resp.json().await?)
}

/// `GET /api/billing/status`.
pub async fn status(
    State(state): State<AppState>,
    user: AuthedUser,
) -> Result<Json<Value>, ApiError> {
    let plan = billing::tenant_plan(&state.stores, user.tenant_id)
        .await
        .map_err(ApiError::from)?;
    let row: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT plan_status, stripe_customer_id FROM tenants WHERE id = $1")
            .bind(user.tenant_id)
            .fetch_optional(&state.stores.pool)
            .await
            .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    let (plan_status, customer) = row.unwrap_or(("active".into(), None));
    Ok(Json(json!({
        "configured": stripe_key().is_some(),
        "plan": plan.id,
        "status": plan_status,
        "currentPeriodEnd": Value::Null,
        "hasCustomer": customer.is_some(),
    })))
}

/// `POST /api/billing/checkout` → `{ url }` (subscribe to Pro).
pub async fn checkout(
    State(state): State<AppState>,
    RequireAdmin(user): RequireAdmin,
) -> Result<Json<Value>, ApiError> {
    let key = stripe_key().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "billing_unconfigured",
            "Stripe is not configured",
        )
    })?;
    let pro = billing::get_plan(&state.stores, "pro")
        .await
        .map_err(ApiError::from)?
        .and_then(|p| p.stripe_price_id)
        .ok_or_else(|| ApiError::bad_request("no Stripe price configured for the Pro plan"))?;
    let base = web_origin();
    let session = stripe_post(
        &key,
        "checkout/sessions",
        &[
            ("mode", "subscription".into()),
            ("line_items[0][price]", pro),
            ("line_items[0][quantity]", "1".into()),
            ("success_url", format!("{base}/admin/settings/billing?ok=1")),
            ("cancel_url", format!("{base}/admin/settings/billing")),
            ("client_reference_id", user.tenant_id.to_string()),
        ],
    )
    .await
    .map_err(ApiError::from)?;
    Ok(Json(json!({ "url": session["url"] })))
}

/// `POST /api/billing/portal` → `{ url }`.
pub async fn portal(
    State(state): State<AppState>,
    RequireAdmin(user): RequireAdmin,
) -> Result<Json<Value>, ApiError> {
    let key = stripe_key().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "billing_unconfigured",
            "Stripe is not configured",
        )
    })?;
    let customer: Option<String> =
        sqlx::query_scalar("SELECT stripe_customer_id FROM tenants WHERE id = $1")
            .bind(user.tenant_id)
            .fetch_optional(&state.stores.pool)
            .await
            .map_err(|e| ApiError::from(anyhow::Error::from(e)))?
            .flatten();
    let customer = customer.ok_or_else(|| ApiError::bad_request("no billing customer yet"))?;
    let base = web_origin();
    let session = stripe_post(
        &key,
        "billing_portal/sessions",
        &[
            ("customer", customer),
            ("return_url", format!("{base}/admin/settings/billing")),
        ],
    )
    .await
    .map_err(ApiError::from)?;
    Ok(Json(json!({ "url": session["url"] })))
}

/// `GET /api/billing/invoices`.
pub async fn invoices(
    State(state): State<AppState>,
    RequireAdmin(user): RequireAdmin,
) -> Result<Json<Value>, ApiError> {
    let Some(key) = stripe_key() else {
        return Ok(Json(json!({ "configured": false, "invoices": [] })));
    };
    let customer: Option<String> =
        sqlx::query_scalar("SELECT stripe_customer_id FROM tenants WHERE id = $1")
            .bind(user.tenant_id)
            .fetch_optional(&state.stores.pool)
            .await
            .map_err(|e| ApiError::from(anyhow::Error::from(e)))?
            .flatten();
    let Some(customer) = customer else {
        return Ok(Json(json!({ "configured": true, "invoices": [] })));
    };
    let client = reqwest::Client::new();
    let resp = client
        .get("https://api.stripe.com/v1/invoices")
        .bearer_auth(&key)
        .query(&[("customer", customer.as_str()), ("limit", "20")])
        .send()
        .await
        .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    let body: Value = resp
        .json()
        .await
        .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    let invoices: Vec<Value> = body["data"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|i| {
                    json!({
                        "id": i["id"],
                        "number": i["number"],
                        "created": i["created"],
                        "total": i["total"],
                        "currency": i["currency"],
                        "status": i["status"],
                        "hostedInvoiceUrl": i["hosted_invoice_url"],
                        "invoicePdf": i["invoice_pdf"],
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Json(json!({ "configured": true, "invoices": invoices })))
}

/// `POST /api/billing/webhook` — Stripe event sync (signature-verified).
pub async fn webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let secret = std::env::var("STRIPE_WEBHOOK_SECRET")
        .ok()
        .filter(|s| !s.is_empty());
    let raw = String::from_utf8_lossy(&body).to_string();

    // Verify Stripe-Signature: t=<ts>,v1=<hmac_sha256(secret, "<ts>.<body>")>.
    if let Some(secret) = &secret {
        let sig = headers
            .get("stripe-signature")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let ts = sig
            .split(',')
            .find_map(|p| p.strip_prefix("t="))
            .unwrap_or("");
        let v1 = sig
            .split(',')
            .find_map(|p| p.strip_prefix("v1="))
            .unwrap_or("");
        let expected = security::hmac_sha256_hex(secret, &format!("{ts}.{raw}"));
        if v1.is_empty() || v1 != expected {
            return Err(ApiError::bad_request("invalid stripe signature"));
        }
    }

    let event: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
    let kind = event["type"].as_str().unwrap_or("");
    let obj = &event["data"]["object"];
    // Sync plan status on subscription lifecycle events.
    if kind.starts_with("customer.subscription") {
        let tenant = obj["metadata"]["tenantId"]
            .as_str()
            .or_else(|| obj["client_reference_id"].as_str());
        if let Some(tid) = tenant.and_then(|s| s.parse::<uuid::Uuid>().ok()) {
            let status = obj["status"].as_str().unwrap_or("active");
            let plan = if status == "active" || status == "trialing" {
                "pro"
            } else {
                "free"
            };
            let _ = sqlx::query("UPDATE tenants SET plan = $2, plan_status = $3 WHERE id = $1")
                .bind(tid)
                .bind(plan)
                .bind(status)
                .execute(&state.stores.pool)
                .await;
        }
    }
    Ok(Json(json!({ "received": true })))
}
