//! Topics / SSOT surface. A topic is a Single Source of Truth page compiled
//! from claims grounded to the topic's concept. Shapes match the api-client
//! (`Topic`, `TopicClaim`, `TopicVersion`, verify/regenerate/case/flashcards).

use axum::extract::{Path, Query, State};
use axum::Json;
use chrono::SecondsFormat;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::AuthedUser;
use crate::error::ApiError;
use crate::state::AppState;
use insight_core::storage::set_tenant;
use insight_core::synth;
use insight_core::tenancy::role_rank;

/// Map an internal claim status to the frontend ClaimStatus enum.
fn claim_status(s: &str) -> &'static str {
    match s {
        "accepted" | "active" => "active",
        "duplicate" => "superseded",
        "needs_review" => "conflicted",
        "retired" => "retired",
        _ => "draft",
    }
}

fn topic_json(
    id: Uuid,
    title: &str,
    version: i32,
    updated: chrono::DateTime<chrono::Utc>,
) -> Value {
    json!({
        "id": id,
        "name": title,
        "aliases": [],
        "health": 100,
        "updates": version,
        "folder": "",
        "lastUpdated": updated.to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}

/// `GET /api/topics` → `{ items, total }`.
pub async fn list_topics(
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
    let rows: Vec<(Uuid, String, i32, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT id, title, version, updated_at FROM topics ORDER BY updated_at DESC LIMIT 500",
    )
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    let items: Vec<Value> = rows
        .iter()
        .map(|(id, title, v, u)| topic_json(*id, title, *v, *u))
        .collect();
    let total = items.len();
    Ok(Json(json!({ "items": items, "total": total })))
}

struct ClaimRow {
    id: Uuid,
    claim_type: String,
    claim_text: String,
    status: String,
    concept: Option<Uuid>,
    system_tags: Option<Value>,
    exam_tags: Option<Value>,
    confidence: Option<Value>,
    created_at: chrono::DateTime<chrono::Utc>,
}

async fn load_topic_claims(
    state: &AppState,
    tenant_id: Uuid,
    topic_id: Uuid,
) -> Result<Vec<ClaimRow>, ApiError> {
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, tenant_id).await?;
    #[derive(sqlx::FromRow)]
    struct Row {
        id: Uuid,
        claim_type: String,
        claim_text: String,
        status: String,
        canonical_concept_id: Option<Uuid>,
        system_tags_json: Option<Value>,
        exam_tags_json: Option<Value>,
        confidence_json: Option<Value>,
        created_at: chrono::DateTime<chrono::Utc>,
    }
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT c.id, c.claim_type, c.claim_text, c.status, c.canonical_concept_id, \
                c.system_tags_json, c.exam_tags_json, c.confidence_json, c.created_at \
         FROM claims c JOIN topics t ON t.canonical_concept_id = c.canonical_concept_id \
         WHERE t.id = $1 ORDER BY c.created_at LIMIT 500",
    )
    .bind(topic_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(rows
        .into_iter()
        .map(|r| ClaimRow {
            id: r.id,
            claim_type: r.claim_type,
            claim_text: r.claim_text,
            status: r.status,
            concept: r.canonical_concept_id,
            system_tags: r.system_tags_json,
            exam_tags: r.exam_tags_json,
            confidence: r.confidence_json,
            created_at: r.created_at,
        })
        .collect())
}

/// `GET /api/topics/{id}` → `{ topic, coverage, delta }`.
pub async fn get_topic(
    State(state): State<AppState>,
    user: AuthedUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let row: Option<(String, i32, chrono::DateTime<chrono::Utc>)> =
        sqlx::query_as("SELECT title, version, updated_at FROM topics WHERE id = $1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    let (title, version, updated) = row.ok_or_else(|| ApiError::not_found("topic not found"))?;

    // Sections: group claims by claim_type; each claim → {id, content, citations}.
    let claims = load_topic_claims(&state, user.tenant_id, id).await?;
    let mut by_type: std::collections::BTreeMap<String, Vec<Value>> =
        std::collections::BTreeMap::new();
    for c in &claims {
        by_type
            .entry(c.claim_type.clone())
            .or_default()
            .push(json!({
                "id": c.id,
                "content": c.claim_text,
                "citations": [],
            }));
    }
    let sections: Vec<Value> = by_type
        .into_iter()
        .enumerate()
        .map(|(i, (kind, cl))| {
            json!({ "id": format!("s{i}"), "title": kind, "icon": "file-text", "claims": cl })
        })
        .collect();

    let mut topic = topic_json(id, &title, version, updated);
    topic["sections"] = json!(sections);
    Ok(Json(json!({ "topic": topic, "coverage": [], "delta": [] })))
}

#[derive(Debug, Deserialize)]
pub struct ClaimsQuery {
    status: Option<String>,
}

/// `GET /api/topics/{id}/claims` → `{ items, total }` (NOT unwrapped by client).
pub async fn get_topic_claims(
    State(state): State<AppState>,
    user: AuthedUser,
    Path(id): Path<Uuid>,
    Query(q): Query<ClaimsQuery>,
) -> Result<Json<Value>, ApiError> {
    let claims = load_topic_claims(&state, user.tenant_id, id).await?;
    let items: Vec<Value> = claims
        .iter()
        .map(|c| {
            let status = claim_status(&c.status);
            json!({
                "id": c.id,
                "topicId": id,
                "sectionId": null,
                "claimType": c.claim_type,
                "claimText": c.claim_text,
                "ontologyIds": c.concept.map(|x| vec![x.to_string()]).unwrap_or_default(),
                "systemTags": c.system_tags.clone().unwrap_or_else(|| json!([])),
                "examTags": c.exam_tags.clone().unwrap_or_else(|| json!([])),
                "confidence": c.confidence.as_ref().and_then(|v| v.get("score")).and_then(Value::as_f64).unwrap_or(0.5),
                "status": status,
                "sources": [],
                "supersedesClaimId": null,
                "supersededByClaimId": null,
                "documentId": null,
                "createdAt": c.created_at.to_rfc3339_opts(SecondsFormat::Millis, true),
                "updatedAt": c.created_at.to_rfc3339_opts(SecondsFormat::Millis, true),
            })
        })
        .filter(|c| {
            q.status
                .as_deref()
                .map(|s| c["status"] == s)
                .unwrap_or(true)
        })
        .collect();
    let total = items.len();
    Ok(Json(json!({ "items": items, "total": total })))
}

#[derive(Debug, Deserialize)]
pub struct NewClaimBody {
    #[serde(default)]
    section_id: Option<String>,
    content: String,
    #[serde(default)]
    citations: Vec<String>,
}

/// `POST /api/topics/{id}/claims` → the created embedded `Claim`.
pub async fn add_claim(
    State(state): State<AppState>,
    user: AuthedUser,
    Path(id): Path<Uuid>,
    Json(body): Json<NewClaimBody>,
) -> Result<Json<Value>, ApiError> {
    if body.content.trim().is_empty() {
        return Err(ApiError::bad_request("content is required"));
    }
    let _ = body.section_id;
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    // Attach to the topic's concept so it appears under the topic.
    let concept: Option<Uuid> =
        sqlx::query_scalar("SELECT canonical_concept_id FROM topics WHERE id = $1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| ApiError::from(anyhow::Error::from(e)))?
            .flatten();
    let claim_id: Uuid = sqlx::query_scalar(
        "INSERT INTO claims (tenant_id, canonical_concept_id, claim_type, claim_text, status) \
         VALUES ($1, $2, 'fact', $3, 'active') RETURNING id",
    )
    .bind(user.tenant_id)
    .bind(concept)
    .bind(body.content.trim())
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(Json(
        json!({ "id": claim_id, "content": body.content.trim(), "citations": body.citations }),
    ))
}

/// `POST /api/topics/{id}/verify` → `TopicVerifyResult` (citation coverage v1).
pub async fn verify_topic(
    State(state): State<AppState>,
    user: AuthedUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let claims = load_topic_claims(&state, user.tenant_id, id).await?;
    let total = claims.len();
    // v1: "supported" = claim has a concept grounding (proxy for evidence).
    let supported = claims.iter().filter(|c| c.concept.is_some()).count();
    let faithfulness = if total > 0 {
        supported as f64 / total as f64
    } else {
        1.0
    };
    Ok(Json(json!({
        "ok": true,
        "strict": true,
        "nliUsed": false,
        "faithfulness": faithfulness,
        "totalSentences": total,
        "supportedSentences": supported,
        "unsupportedCount": total - supported,
        "evidenceClaims": supported,
        "sections": [],
        "verifiedAt": chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    })))
}

/// `POST /api/topics/{id}/regenerate` → recompose from evidence.
pub async fn regenerate_topic(
    State(state): State<AppState>,
    user: AuthedUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    match synth::synthesize(&state.stores, user.tenant_id, id).await {
        Ok(r) => Ok(Json(json!({
            "ok": true,
            "faithfulness": r.faithfulness,
            "claims": r.claims,
            "version": r.version,
        }))),
        Err(e) => Ok(Json(json!({ "ok": false, "reason": format!("{e:#}") }))),
    }
}

#[derive(Debug, Deserialize)]
pub struct VersionsQuery {
    include: Option<String>,
}

/// `GET /api/topics/{id}/versions` → `{ items, total }` (client unwraps).
pub async fn list_versions(
    State(state): State<AppState>,
    user: AuthedUser,
    Path(id): Path<Uuid>,
    Query(q): Query<VersionsQuery>,
) -> Result<Json<Value>, ApiError> {
    let include_snapshot = q.include.as_deref() == Some("snapshot");
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    #[derive(sqlx::FromRow)]
    struct VersionRow {
        version: i32,
        page_md: Option<String>,
        changelog: Option<String>,
        created_at: chrono::DateTime<chrono::Utc>,
    }
    let rows: Vec<VersionRow> = sqlx::query_as(
        "SELECT version, page_md, changelog, created_at FROM topic_versions \
             WHERE topic_id = $1 ORDER BY version DESC",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    let items: Vec<Value> = rows
        .iter()
        .map(|r| {
            let mut o = json!({
                "id": format!("{id}:{}", r.version),
                "topicId": id,
                "version": r.version,
                "pageMd": r.page_md.clone().unwrap_or_default(),
                "changelog": [{ "type": "update", "text": r.changelog.clone().unwrap_or_default(), "details": "" }],
                "faithfulness": null,
                "createdBy": null,
                "createdAt": r.created_at.to_rfc3339_opts(SecondsFormat::Millis, true),
            });
            if include_snapshot {
                o["sectionsSnapshot"] = json!([]);
            }
            o
        })
        .collect();
    let total = items.len();
    Ok(Json(json!({ "items": items, "total": total })))
}

/// `POST /api/topics/{id}/versions/{version}/restore` (editor).
pub async fn restore_version(
    State(state): State<AppState>,
    user: AuthedUser,
    Path((id, version)): Path<(Uuid, i32)>,
) -> Result<Json<Value>, ApiError> {
    if role_rank(&user.role) < role_rank("editor") {
        return Err(ApiError::forbidden("requires editor role or higher"));
    }
    if version < 1 {
        return Err(ApiError::bad_request("version must be >= 1"));
    }
    let r = synth::restore_version(&state.stores, user.tenant_id, id, version)
        .await
        .map_err(|e| ApiError::not_found(format!("{e:#}")))?;
    Ok(Json(json!({
        "ok": true,
        "restoredFrom": version,
        "version": r.version,
        "faithfulness": r.faithfulness,
    })))
}

/// `POST /api/topics/{id}/case` → `{ case }`.
pub async fn generate_case(
    State(state): State<AppState>,
    user: AuthedUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let case = synth::generate_case(&state.stores, user.tenant_id, id)
        .await
        .map_err(|e| {
            ApiError::new(
                axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                "no_evidence",
                format!("{e:#}"),
            )
        })?;
    Ok(Json(json!({ "case": case })))
}

#[derive(Debug, Default, Deserialize)]
pub struct FlashcardsBody {
    count: Option<usize>,
}

/// `POST /api/topics/{id}/flashcards` → `{ generated }`.
pub async fn generate_flashcards(
    State(state): State<AppState>,
    user: AuthedUser,
    Path(id): Path<Uuid>,
    body: Option<Json<FlashcardsBody>>,
) -> Result<Json<Value>, ApiError> {
    let count = body.and_then(|b| b.0.count).unwrap_or(8);
    let generated = synth::generate_flashcards(&state.stores, user.tenant_id, id, count)
        .await
        .map_err(ApiError::from)?;
    Ok(Json(json!({ "generated": generated })))
}
