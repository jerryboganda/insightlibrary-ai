//! Super-admin platform console: cross-tenant org management, plan catalog CRUD,
//! and a platform overview. All routes require the `super_admin` platform role.

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::RequireSuperAdmin;
use crate::error::ApiError;
use crate::state::AppState;
use insight_core::billing;

/// `GET /api/admin/orgs` (super-admin) → `{ items, total }`.
pub async fn list_orgs(
    State(state): State<AppState>,
    _su: RequireSuperAdmin,
) -> Result<Json<Value>, ApiError> {
    let items = billing::list_orgs(&state.stores)
        .await
        .map_err(ApiError::from)?;
    let total = items.len();
    Ok(Json(json!({ "items": items, "total": total })))
}

#[derive(Debug, Deserialize)]
pub struct OrgPatch {
    plan: Option<String>,
    suspended: Option<bool>,
    name: Option<String>,
}

/// `PATCH /api/admin/orgs/{id}` (super-admin) — set plan / suspend / rename.
pub async fn update_org(
    State(state): State<AppState>,
    _su: RequireSuperAdmin,
    Path(id): Path<uuid::Uuid>,
    Json(body): Json<OrgPatch>,
) -> Result<Json<Value>, ApiError> {
    if body.plan.is_none() && body.suspended.is_none() && body.name.is_none() {
        return Err(ApiError::bad_request("nothing to update"));
    }
    // Validate plan id when provided.
    if let Some(plan) = &body.plan {
        if billing::get_plan(&state.stores, plan).await?.is_none() {
            return Err(ApiError::bad_request("unknown plan"));
        }
    }
    let row: Option<(uuid::Uuid, String, String, bool)> = sqlx::query_as(
        "UPDATE tenants SET plan = COALESCE($2, plan), suspended = COALESCE($3, suspended), \
                name = COALESCE($4, name) WHERE id = $1 RETURNING id, name, plan, suspended",
    )
    .bind(id)
    .bind(body.plan)
    .bind(body.suspended)
    .bind(body.name)
    .fetch_optional(&state.stores.pool)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    let (id, name, plan, suspended) = row.ok_or_else(|| ApiError::not_found("org not found"))?;
    Ok(Json(
        json!({ "id": id, "name": name, "plan": plan, "suspended": suspended }),
    ))
}

/// `GET /api/admin/plans` (super-admin) → `{ items, total }`.
pub async fn list_plans(
    State(state): State<AppState>,
    _su: RequireSuperAdmin,
) -> Result<Json<Value>, ApiError> {
    let plans = billing::list_plans(&state.stores)
        .await
        .map_err(ApiError::from)?;
    let items: Vec<Value> = plans.iter().map(|p| p.to_json()).collect();
    let total = items.len();
    Ok(Json(json!({ "items": items, "total": total })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanBody {
    id: String,
    name: String,
    seats: Option<i32>,
    document_cap: Option<i32>,
    ai_budget_usd: Option<f64>,
    stripe_price_id: Option<String>,
    features: Option<Value>,
    active: Option<bool>,
}

/// `POST /api/admin/plans` (super-admin) — upsert a plan.
pub async fn upsert_plan(
    State(state): State<AppState>,
    _su: RequireSuperAdmin,
    Json(body): Json<PlanBody>,
) -> Result<Json<Value>, ApiError> {
    if body.id.trim().is_empty() {
        return Err(ApiError::bad_request("plan id is required"));
    }
    sqlx::query(
        "INSERT INTO plans (id, name, seats, document_cap, ai_budget_usd, stripe_price_id, features, active) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
         ON CONFLICT (id) DO UPDATE SET name = $2, seats = $3, document_cap = $4, \
           ai_budget_usd = $5, stripe_price_id = $6, features = $7, active = $8, updated_at = now()",
    )
    .bind(&body.id)
    .bind(&body.name)
    .bind(body.seats.unwrap_or(0))
    .bind(body.document_cap.unwrap_or(0))
    .bind(body.ai_budget_usd.unwrap_or(0.0))
    .bind(&body.stripe_price_id)
    .bind(body.features.clone().unwrap_or_else(|| json!([])))
    .bind(body.active.unwrap_or(true))
    .execute(&state.stores.pool)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    let plan = billing::get_plan(&state.stores, &body.id)
        .await
        .map_err(ApiError::from)?
        .ok_or_else(|| ApiError::from(anyhow::anyhow!("plan vanished")))?;
    Ok(Json(plan.to_json()))
}

/// `GET /api/admin/overview` (super-admin) → platform totals.
pub async fn overview(
    State(state): State<AppState>,
    _su: RequireSuperAdmin,
) -> Result<Json<Value>, ApiError> {
    // Global counts (super-admin sees the whole platform; RLS-exempt aggregate
    // reads on the tenancy root + a superuser-safe count would need a dedicated
    // path — here we count tenants + sum per-table counts via the app role).
    let (orgs,): (i64,) = sqlx::query_as("SELECT count(*) FROM tenants")
        .fetch_one(&state.stores.pool)
        .await
        .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    let by_plan: Vec<(String, i64)> =
        sqlx::query_as("SELECT plan, count(*) FROM tenants GROUP BY plan")
            .fetch_all(&state.stores.pool)
            .await
            .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    let (suspended,): (i64,) = sqlx::query_as("SELECT count(*) FROM tenants WHERE suspended")
        .fetch_one(&state.stores.pool)
        .await
        .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    let plans_json: Vec<Value> = by_plan
        .iter()
        .map(|(p, n)| json!({ "plan": p, "count": n }))
        .collect();
    Ok(Json(json!({
        "orgs": orgs,
        "suspended": suspended,
        "byPlan": plans_json,
    })))
}
