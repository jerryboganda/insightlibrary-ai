//! Research workspace projects (argument_map / compare_matrix / report /
//! timeline). Shapes match the api-client `ResearchProject` (single `data`
//! blob). Writes require `editor`.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use chrono::SecondsFormat;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::AuthedUser;
use crate::error::ApiError;
use crate::state::AppState;
use insight_core::llm::{self, Task};
use insight_core::storage::set_tenant;
use insight_core::tenancy::role_rank;

const TYPES: &[&str] = &["argument_map", "compare_matrix", "report", "timeline"];

fn require_editor(user: &AuthedUser) -> Result<(), ApiError> {
    if role_rank(&user.role) < role_rank("editor") {
        return Err(ApiError::forbidden("requires editor role or higher"));
    }
    Ok(())
}

fn empty_data(kind: &str) -> Value {
    match kind {
        "argument_map" => json!({ "nodes": [] }),
        "compare_matrix" => json!({ "columns": [], "rows": [] }),
        "report" => json!({ "prompt": "", "strictCitation": false, "sources": [], "body": "" }),
        "timeline" => json!({ "events": [] }),
        _ => json!({}),
    }
}

#[derive(sqlx::FromRow)]
struct ProjectRow {
    id: Uuid,
    kind: String,
    title: String,
    data: Value,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
}

fn project_json(p: &ProjectRow) -> Value {
    json!({
        "id": p.id,
        "type": p.kind,
        "title": p.title,
        "data": p.data,
        "createdAt": p.created_at.to_rfc3339_opts(SecondsFormat::Millis, true),
        "updatedAt": p.updated_at.to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}

const SELECT: &str = "SELECT id, kind, title, data, created_at, updated_at FROM research_projects";

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    #[serde(rename = "type")]
    kind: Option<String>,
}

/// `GET /api/research[?type]` → `{ items, total }`.
pub async fn list_research(
    State(state): State<AppState>,
    user: AuthedUser,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    if let Some(k) = &q.kind {
        if !TYPES.contains(&k.as_str()) {
            return Err(ApiError::bad_request(format!(
                "unknown research type \"{k}\""
            )));
        }
    }
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let rows: Vec<ProjectRow> = sqlx::query_as(&format!(
        "{SELECT} WHERE ($1::text IS NULL OR kind = $1) ORDER BY updated_at DESC LIMIT 500"
    ))
    .bind(&q.kind)
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    let items: Vec<Value> = rows.iter().map(project_json).collect();
    let total = items.len();
    Ok(Json(json!({ "items": items, "total": total })))
}

#[derive(Debug, Deserialize)]
pub struct CreateBody {
    #[serde(rename = "type")]
    kind: String,
    title: String,
}

/// `POST /api/research` (editor) → created `ResearchProject` (201).
pub async fn create_research(
    State(state): State<AppState>,
    user: AuthedUser,
    Json(body): Json<CreateBody>,
) -> Result<axum::response::Response, ApiError> {
    require_editor(&user)?;
    if !TYPES.contains(&body.kind.as_str()) {
        return Err(ApiError::bad_request("unknown research type"));
    }
    let title = body.title.trim();
    if title.is_empty() {
        return Err(ApiError::bad_request("title is required"));
    }
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let row: ProjectRow = sqlx::query_as(
        "INSERT INTO research_projects (tenant_id, kind, title, data, created_by) \
         VALUES ($1, $2, $3, $4, $5) RETURNING id, kind, title, data, created_at, updated_at",
    )
    .bind(user.tenant_id)
    .bind(&body.kind)
    .bind(title)
    .bind(empty_data(&body.kind))
    .bind(user.user_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok((StatusCode::CREATED, Json(project_json(&row))).into_response())
}

async fn load_project(state: &AppState, tenant_id: Uuid, id: Uuid) -> Result<ProjectRow, ApiError> {
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, tenant_id).await?;
    let row: Option<ProjectRow> = sqlx::query_as(&format!("{SELECT} WHERE id = $1"))
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    row.ok_or_else(|| ApiError::not_found("research project not found"))
}

/// `GET /api/research/{id}`.
pub async fn get_research(
    State(state): State<AppState>,
    user: AuthedUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let row = load_project(&state, user.tenant_id, id).await?;
    Ok(Json(project_json(&row)))
}

#[derive(Debug, Deserialize)]
pub struct PatchBody {
    title: Option<String>,
    data: Option<Value>,
}

/// `PATCH /api/research/{id}` (editor).
pub async fn update_research(
    State(state): State<AppState>,
    user: AuthedUser,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchBody>,
) -> Result<Json<Value>, ApiError> {
    require_editor(&user)?;
    if body.title.is_none() && body.data.is_none() {
        return Err(ApiError::bad_request("at least one of title/data required"));
    }
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let row: Option<ProjectRow> = sqlx::query_as(
        "UPDATE research_projects SET \
           title = COALESCE($2, title), \
           data = COALESCE($3, data), \
           updated_at = now() \
         WHERE id = $1 RETURNING id, kind, title, data, created_at, updated_at",
    )
    .bind(id)
    .bind(body.title.as_deref().map(str::trim))
    .bind(&body.data)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    let row = row.ok_or_else(|| ApiError::not_found("research project not found"))?;
    Ok(Json(project_json(&row)))
}

/// `DELETE /api/research/{id}` (editor).
pub async fn delete_research(
    State(state): State<AppState>,
    user: AuthedUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    require_editor(&user)?;
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let done = sqlx::query("DELETE FROM research_projects WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|e| ApiError::from(anyhow::Error::from(e)))?
        .rows_affected();
    tx.commit().await.map_err(anyhow::Error::from)?;
    if done == 0 {
        return Err(ApiError::not_found("research project not found"));
    }
    Ok(Json(json!({ "ok": true })))
}

/// `POST /api/research/{id}/generate` (editor) → report generation.
pub async fn generate_research(
    State(state): State<AppState>,
    user: AuthedUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    require_editor(&user)?;
    let project = load_project(&state, user.tenant_id, id).await?;
    if project.kind != "report" {
        return Err(ApiError::bad_request(
            "only report projects can be generated",
        ));
    }
    let prompt = project
        .data
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let strict = project
        .data
        .get("strictCitation")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    // Evidence from hybrid search over the prompt/title.
    let query = if prompt.trim().is_empty() {
        project.title.clone()
    } else {
        prompt.clone()
    };
    let hits = insight_core::retrieve::search(&state.stores, user.tenant_id, &query, 12)
        .await
        .unwrap_or_default();
    if hits.is_empty() {
        return Ok(Json(
            json!({ "ok": false, "reason": "no evidence found for this report" }),
        ));
    }
    let context = hits
        .iter()
        .map(|h| format!("- {}", h.snippet))
        .collect::<Vec<_>>()
        .join("\n");
    let system = if strict {
        "Write a well-structured report grounded ONLY in the provided context. Cite sources."
    } else {
        "Write a well-structured report from the provided context and the prompt."
    };
    let completion = llm::complete_metered(
        &state.stores,
        user.tenant_id,
        Some(user.user_id),
        Task::Synthesis,
        system,
        &format!("Prompt: {query}\n\nContext:\n{context}\n\nWrite the report."),
    )
    .await;

    let (body_text, generated_by) = match completion {
        Ok(c) => (c.text, "ai"),
        Err(_) => (format!("## {}\n\n{}", project.title, context), "fallback"),
    };
    let word_count = body_text.split_whitespace().count();

    // Persist onto the project's data.
    let mut data = project.data.clone();
    if let Some(obj) = data.as_object_mut() {
        obj.insert("body".into(), json!(body_text));
        obj.insert("generatedBy".into(), json!(generated_by));
        obj.insert(
            "generatedAt".into(),
            json!(chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)),
        );
        obj.insert("wordCount".into(), json!(word_count));
        obj.insert("citationCount".into(), json!(hits.len()));
    }
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let updated: ProjectRow = sqlx::query_as(
        "UPDATE research_projects SET data = $2, updated_at = now() WHERE id = $1 \
         RETURNING id, kind, title, data, created_at, updated_at",
    )
    .bind(id)
    .bind(&data)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;

    Ok(Json(json!({
        "ok": true,
        "generatedBy": generated_by,
        "body": body_text,
        "wordCount": word_count,
        "citationCount": hits.len(),
        "project": project_json(&updated),
    })))
}
