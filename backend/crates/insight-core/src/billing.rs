//! Billing + plans/quotas (Phase 13): plan catalog resolution and seat /
//! document-cap enforcement. Stripe REST calls + webhook verification live in
//! the API layer; this module owns the entitlement math.

use anyhow::Context;
use serde_json::Value;
use uuid::Uuid;

use crate::storage::{set_tenant, Stores};

/// A plan tier.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Plan {
    pub id: String,
    pub name: String,
    pub seats: i32,
    pub document_cap: i32,
    pub ai_budget_usd: f64,
    pub stripe_price_id: Option<String>,
    pub features: Value,
    pub active: bool,
}

impl Plan {
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "id": self.id,
            "name": self.name,
            "seats": self.seats,
            "documentCap": self.document_cap,
            "aiBudgetUsd": self.ai_budget_usd,
            "stripePriceId": self.stripe_price_id,
            "features": self.features,
            "active": self.active,
        })
    }
}

const SELECT_PLAN: &str =
    "SELECT id, name, seats, document_cap, ai_budget_usd, stripe_price_id, features, active FROM plans";

/// The default plan when a tenant references none / an unknown id.
fn free_plan() -> Plan {
    Plan {
        id: "free".into(),
        name: "Free".into(),
        seats: 3,
        document_cap: 100,
        ai_budget_usd: 10.0,
        stripe_price_id: None,
        features: serde_json::json!([]),
        active: true,
    }
}

/// List all plans.
pub async fn list_plans(stores: &Stores) -> anyhow::Result<Vec<Plan>> {
    let plans: Vec<Plan> = sqlx::query_as(&format!("{SELECT_PLAN} ORDER BY ai_budget_usd"))
        .fetch_all(&stores.pool)
        .await
        .context("list plans")?;
    Ok(plans)
}

/// Fetch a plan by id.
pub async fn get_plan(stores: &Stores, id: &str) -> anyhow::Result<Option<Plan>> {
    let plan: Option<Plan> = sqlx::query_as(&format!("{SELECT_PLAN} WHERE id = $1"))
        .bind(id)
        .fetch_optional(&stores.pool)
        .await
        .context("get plan")?;
    Ok(plan)
}

/// Resolve a tenant's effective plan (falls back to free).
pub async fn tenant_plan(stores: &Stores, tenant_id: Uuid) -> anyhow::Result<Plan> {
    let plan_id: Option<String> = sqlx::query_scalar("SELECT plan FROM tenants WHERE id = $1")
        .bind(tenant_id)
        .fetch_optional(&stores.pool)
        .await
        .context("read tenant plan")?
        .flatten();
    match plan_id {
        Some(id) => Ok(get_plan(stores, &id).await?.unwrap_or_else(free_plan)),
        None => Ok(free_plan()),
    }
}

/// Count active members of a tenant (home users + memberships).
async fn member_count(stores: &Stores, tenant_id: Uuid) -> anyhow::Result<i64> {
    let mut tx = stores.pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM users WHERE status <> 'suspended'")
        .fetch_one(&mut *tx)
        .await
        .context("count members")?;
    tx.commit().await?;
    Ok(n)
}

/// Count a tenant's documents.
async fn document_count(stores: &Stores, tenant_id: Uuid) -> anyhow::Result<i64> {
    let mut tx = stores.pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM documents")
        .fetch_one(&mut *tx)
        .await
        .context("count documents")?;
    tx.commit().await?;
    Ok(n)
}

/// Ensure the tenant is below its seat cap before adding a member/invite.
/// Returns `Some(message)` when at/over the cap, `None` when allowed.
pub async fn check_seat(stores: &Stores, tenant_id: Uuid) -> anyhow::Result<Option<String>> {
    let plan = tenant_plan(stores, tenant_id).await?;
    if plan.seats <= 0 {
        return Ok(None); // unlimited
    }
    let used = member_count(stores, tenant_id).await?;
    if used >= plan.seats as i64 {
        return Ok(Some(format!(
            "seat limit reached ({} of {})",
            used, plan.seats
        )));
    }
    Ok(None)
}

/// Ensure the tenant is below its document cap before creating a document.
/// Returns `Some(message)` when at/over the cap, `None` when allowed.
pub async fn check_document_cap(
    stores: &Stores,
    tenant_id: Uuid,
) -> anyhow::Result<Option<String>> {
    let plan = tenant_plan(stores, tenant_id).await?;
    if plan.document_cap <= 0 {
        return Ok(None);
    }
    let used = document_count(stores, tenant_id).await?;
    if used >= plan.document_cap as i64 {
        return Ok(Some(format!(
            "document limit reached ({} of {})",
            used, plan.document_cap
        )));
    }
    Ok(None)
}

/// A tenant/org summary for the super-admin console.
pub async fn list_orgs(stores: &Stores) -> anyhow::Result<Vec<Value>> {
    #[derive(sqlx::FromRow)]
    struct Row {
        id: Uuid,
        kind: String,
        name: String,
        plan: String,
        suspended: bool,
        created_at: chrono::DateTime<chrono::Utc>,
    }
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT id, kind, name, plan, suspended, created_at FROM tenants ORDER BY created_at DESC LIMIT 500",
    )
    .fetch_all(&stores.pool)
    .await
    .context("list orgs")?;
    Ok(rows
        .into_iter()
        .map(|r| {
            serde_json::json!({
                "id": r.id,
                "kind": r.kind,
                "name": r.name,
                "plan": r.plan,
                "suspended": r.suspended,
                "createdAt": r.created_at.to_rfc3339(),
            })
        })
        .collect())
}
