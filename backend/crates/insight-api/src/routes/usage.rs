//! AI usage + cost ledger (`GET /api/usage`). Aggregates metered LLM calls from
//! `usage_records` into the `UsageMetrics` shape: a budget block, a per
//! provider+model rollup, and an events summary.

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::AuthedUser;
use crate::error::ApiError;
use crate::state::AppState;
use insight_core::settings;
use insight_core::storage::set_tenant;

#[derive(Debug, Deserialize)]
pub struct UsageQuery {
    #[serde(default)]
    period: Option<String>,
}

/// `GET /api/usage?period=month|all`.
pub async fn get_usage(
    State(state): State<AppState>,
    user: AuthedUser,
    Query(q): Query<UsageQuery>,
) -> Result<Json<Value>, ApiError> {
    let period = match q.period.as_deref() {
        Some("all") => "all",
        _ => "month",
    };
    let month_only = period == "month";

    let cfg = state.stores.settings.resolve_org(user.tenant_id).await?;
    let limit = settings::org_f64(&cfg, "budgetMonthlyLimitUsd", 0.0);
    let soft = settings::org_i64(&cfg, "budgetSoftThresholdPct", 80);

    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id)
        .await
        .map_err(ApiError::from)?;

    // Per provider+model rollup.
    #[derive(sqlx::FromRow)]
    struct Row {
        provider: Option<String>,
        model: Option<String>,
        calls: i64,
        tokens_in: Option<i64>,
        tokens_out: Option<i64>,
        cost_micro: Option<i64>,
    }
    let filter = if month_only {
        "AND ts >= date_trunc('month', now())"
    } else {
        ""
    };
    // SUM over bigint returns NUMERIC in Postgres — cast back to bigint so it
    // decodes into i64.
    let sql = format!(
        "SELECT meta->>'provider' AS provider, meta->>'model' AS model, \
                count(*) AS calls, \
                COALESCE(SUM((meta->>'inTokens')::bigint), 0)::bigint AS tokens_in, \
                COALESCE(SUM((meta->>'outTokens')::bigint), 0)::bigint AS tokens_out, \
                COALESCE(SUM(quantity), 0)::bigint AS cost_micro \
         FROM usage_records WHERE metric = 'llm' {filter} \
         GROUP BY 1, 2 ORDER BY cost_micro DESC"
    );
    let rows: Vec<Row> = sqlx::query_as(&sql)
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;

    // Month spend (always month, for the budget block).
    let (month_micro,): (Option<i64>,) = sqlx::query_as(
        "SELECT COALESCE(SUM(quantity), 0)::bigint FROM usage_records \
         WHERE metric = 'llm' AND ts >= date_trunc('month', now())",
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;

    // Earliest metered event.
    let (metered_since,): (Option<chrono::DateTime<chrono::Utc>>,) =
        sqlx::query_as("SELECT MIN(ts) FROM usage_records WHERE metric = 'llm'")
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;

    let by_provider: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "provider": r.provider.clone().unwrap_or_default(),
                "model": r.model.clone().unwrap_or_default(),
                "calls": r.calls,
                "tokensIn": r.tokens_in.unwrap_or(0),
                "tokensOut": r.tokens_out.unwrap_or(0),
                "costUsd": r.cost_micro.unwrap_or(0) as f64 / 1e6,
            })
        })
        .collect();

    let total_calls: i64 = rows.iter().map(|r| r.calls).sum();
    let period_cost_usd: f64 =
        rows.iter().map(|r| r.cost_micro.unwrap_or(0)).sum::<i64>() as f64 / 1e6;
    let month_spend = month_micro.unwrap_or(0) as f64 / 1e6;

    // events summary: one entry per provider (name, count, cost).
    let events: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "name": r.provider.clone().unwrap_or_else(|| "llm".into()),
                "count": r.calls,
                "cost": r.cost_micro.unwrap_or(0) as f64 / 1e6,
            })
        })
        .collect();

    Ok(Json(json!({
        "monthlyBudget": limit,
        "currentSpend": month_spend,
        "queries": total_calls,
        "costPerQuery": if total_calls > 0 { period_cost_usd / total_calls as f64 } else { 0.0 },
        "activeUsers": 0,
        "storageGB": 0.0,
        "events": events,
        "period": period,
        "budget": {
            "monthlyLimitUsd": limit,
            "softThresholdPct": soft,
            "spendThisMonthUsd": month_spend,
            "enforced": limit > 0.0,
        },
        "byProvider": by_provider,
        "meteredSince": metered_since,
    })))
}
