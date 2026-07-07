//! Evaluation: metrics + trend history, run trigger, and golden-set CRUD.
//! Golden CRUD requires `admin`. Shapes match the api-client.

use axum::extract::{Path, Query, State};
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
use insight_core::eval;
use insight_core::storage::set_tenant;

#[derive(Debug, Deserialize)]
pub struct HistoryQuery {
    history: Option<i64>,
}

/// `GET /api/evaluation?history=n` → metrics + `{ history }`.
pub async fn get_evaluation(
    State(state): State<AppState>,
    user: AuthedUser,
    Query(q): Query<HistoryQuery>,
) -> Result<Json<Value>, ApiError> {
    let limit = q.history.unwrap_or(10).clamp(1, 50);
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    #[derive(sqlx::FromRow)]
    struct RunRow {
        id: Uuid,
        faithfulness: f64,
        citation_accuracy: f64,
        hallucination_rate: f64,
        novelty_precision: f64,
        created_at: chrono::DateTime<chrono::Utc>,
    }
    let runs: Vec<RunRow> = sqlx::query_as(
        "SELECT id, faithfulness, citation_accuracy, hallucination_rate, novelty_precision, created_at \
         FROM eval_runs ORDER BY created_at DESC LIMIT $1",
    )
    .bind(limit)
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;

    let latest = runs.first();
    let history: Vec<Value> = runs
        .iter()
        .map(|r| {
            json!({
                "id": r.id,
                "faithfulness": r.faithfulness,
                "citationAccuracy": r.citation_accuracy,
                "hallucinationRate": r.hallucination_rate,
                "noveltyPrecision": r.novelty_precision,
                "createdAt": r.created_at.to_rfc3339_opts(SecondsFormat::Millis, true),
            })
        })
        .collect();
    Ok(Json(json!({
        "faithfulness": latest.map(|r| r.faithfulness).unwrap_or(0.0),
        "citationAccuracy": latest.map(|r| r.citation_accuracy).unwrap_or(0.0),
        "hallucinationRate": latest.map(|r| r.hallucination_rate).unwrap_or(0.0),
        "noveltyPrecision": latest.map(|r| r.novelty_precision).unwrap_or(0.0),
        "recentTests": [],
        "history": history,
    })))
}

/// `POST /api/evaluation/run` → runs the golden set, returns metrics.
pub async fn run_evaluation(
    State(state): State<AppState>,
    user: AuthedUser,
) -> Result<Json<Value>, ApiError> {
    let metrics = eval::run_golden_eval(&state.stores, user.tenant_id)
        .await
        .map_err(ApiError::from)?;
    Ok(Json(metrics.to_json()))
}

#[derive(sqlx::FromRow)]
struct GoldenRow {
    id: Uuid,
    query: String,
    expect: String,
    source: String,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
}

fn golden_json(g: &GoldenRow) -> Value {
    json!({
        "id": g.id,
        "query": g.query,
        "expect": g.expect,
        "source": g.source,
        "createdAt": g.created_at.to_rfc3339_opts(SecondsFormat::Millis, true),
        "updatedAt": g.updated_at.to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}

/// `GET /api/evaluation/golden` (admin) → `{ items, total }`.
pub async fn list_golden(
    State(state): State<AppState>,
    RequireAdmin(user): RequireAdmin,
) -> Result<Json<Value>, ApiError> {
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let rows: Vec<GoldenRow> = sqlx::query_as(
        "SELECT id, query, expect, source, created_at, updated_at FROM golden_items ORDER BY created_at",
    )
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    let items: Vec<Value> = rows.iter().map(golden_json).collect();
    let total = items.len();
    Ok(Json(json!({ "items": items, "total": total })))
}

#[derive(Debug, Deserialize)]
pub struct CreateGoldenBody {
    query: String,
    expect: String,
}

/// `POST /api/evaluation/golden` (admin) → created `GoldenRecord` (201).
pub async fn create_golden(
    State(state): State<AppState>,
    RequireAdmin(user): RequireAdmin,
    Json(body): Json<CreateGoldenBody>,
) -> Result<axum::response::Response, ApiError> {
    let query = body.query.trim();
    let expect = body.expect.trim();
    if query.is_empty() || expect.is_empty() {
        return Err(ApiError::bad_request(
            "invalid golden item: query and expect required",
        ));
    }
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let row: GoldenRow = sqlx::query_as(
        "INSERT INTO golden_items (tenant_id, query, expect, source) VALUES ($1, $2, $3, 'custom') \
         RETURNING id, query, expect, source, created_at, updated_at",
    )
    .bind(user.tenant_id)
    .bind(query)
    .bind(expect)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok((StatusCode::CREATED, Json(golden_json(&row))).into_response())
}

#[derive(Debug, Deserialize)]
pub struct PatchGoldenBody {
    query: Option<String>,
    expect: Option<String>,
}

/// `PATCH /api/evaluation/golden/{id}` (admin).
pub async fn update_golden(
    State(state): State<AppState>,
    RequireAdmin(user): RequireAdmin,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchGoldenBody>,
) -> Result<Json<Value>, ApiError> {
    if body.query.is_none() && body.expect.is_none() {
        return Err(ApiError::bad_request(
            "invalid update: query or expect required",
        ));
    }
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let row: Option<GoldenRow> = sqlx::query_as(
        "UPDATE golden_items SET query = COALESCE($2, query), expect = COALESCE($3, expect), \
                updated_at = now() WHERE id = $1 \
         RETURNING id, query, expect, source, created_at, updated_at",
    )
    .bind(id)
    .bind(body.query.as_deref().map(str::trim))
    .bind(body.expect.as_deref().map(str::trim))
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    let row = row.ok_or_else(|| ApiError::not_found("golden item not found"))?;
    Ok(Json(golden_json(&row)))
}

/// `DELETE /api/evaluation/golden/{id}` (admin).
pub async fn delete_golden(
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
    let done = sqlx::query("DELETE FROM golden_items WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|e| ApiError::from(anyhow::Error::from(e)))?
        .rows_affected();
    tx.commit().await.map_err(anyhow::Error::from)?;
    if done == 0 {
        return Err(ApiError::not_found("golden item not found"));
    }
    Ok(Json(json!({ "ok": true })))
}
