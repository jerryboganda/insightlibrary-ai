//! Ontology registry + schema editor + import + entity-linking test. The
//! catalog rows live per-tenant in `ontologies`; the concepts they load are in
//! the SHARED `concepts` table. Writes require `admin`.

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
use insight_core::ontology;
use insight_core::storage::set_tenant;

const RESERVED: &[&str] = &["mesh", "mondo", "hpo", "rxnorm", "umls", "snomed"];
const MAX_SYNC_CONCEPTS: usize = 2000;

fn slugify(s: &str) -> String {
    s.trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

#[derive(sqlx::FromRow)]
struct OntologyRow {
    id: Uuid,
    name: String,
    prefix: Option<String>,
    status: String,
    schema_json: Value,
    updated_at: chrono::DateTime<chrono::Utc>,
}

/// Count concepts + synonyms for an ontology prefix (shared table).
async fn concept_counts(state: &AppState, prefix: &str) -> (i64, i64) {
    if prefix.is_empty() {
        return (0, 0);
    }
    let mut conn = match state.stores.pool.acquire().await {
        Ok(c) => c,
        Err(_) => return (0, 0),
    };
    let entities: i64 = sqlx::query_scalar("SELECT count(*) FROM concepts WHERE ontology = $1")
        .bind(prefix.to_uppercase())
        .fetch_one(&mut *conn)
        .await
        .unwrap_or(0);
    let synonyms: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(jsonb_array_length(COALESCE(synonyms_json, '[]'::jsonb))), 0)::bigint \
         FROM concepts WHERE ontology = $1",
    )
    .bind(prefix.to_uppercase())
    .fetch_one(&mut *conn)
    .await
    .unwrap_or(0);
    (entities, synonyms)
}

/// `GET /api/ontologies` → `{ items, total }`.
pub async fn list_ontologies(
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
    let rows: Vec<OntologyRow> = sqlx::query_as(
        "SELECT id, name, prefix, status, schema_json, updated_at FROM ontologies ORDER BY name",
    )
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;

    let mut items = Vec::new();
    for r in &rows {
        let (entities, relations) = concept_counts(&state, r.prefix.as_deref().unwrap_or("")).await;
        items.push(json!({
            "id": r.id,
            "name": r.name,
            "entities": entities,
            "relations": relations,
            "status": r.status,
            "lastUpdated": r.updated_at.to_rfc3339_opts(SecondsFormat::Millis, true),
        }));
    }
    let total = items.len();
    Ok(Json(json!({ "items": items, "total": total })))
}

#[derive(Debug, Deserialize)]
pub struct CreateBody {
    name: String,
    slug: Option<String>,
    description: Option<String>,
}

/// `POST /api/ontologies` (admin) → created summary (201).
pub async fn create_ontology(
    State(state): State<AppState>,
    RequireAdmin(user): RequireAdmin,
    Json(body): Json<CreateBody>,
) -> Result<axum::response::Response, ApiError> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::bad_request("name is required"));
    }
    let slug = slugify(body.slug.as_deref().unwrap_or(name));
    if RESERVED.contains(&slug.as_str()) {
        return Err(ApiError::conflict("that ontology slug is reserved"));
    }
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO ontologies (tenant_id, name, description, prefix) \
         VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(user.tenant_id)
    .bind(name)
    .bind(&body.description)
    .bind(&slug)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "id": id, "ontology": slug, "name": name,
            "entities": 0, "relations": 0, "status": "draft",
        })),
    )
        .into_response())
}

/// `DELETE /api/ontologies/{id}` (admin).
pub async fn delete_ontology(
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
    let prefix: Option<String> = sqlx::query_scalar("SELECT prefix FROM ontologies WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| ApiError::from(anyhow::Error::from(e)))?
        .flatten();
    let done = sqlx::query("DELETE FROM ontologies WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|e| ApiError::from(anyhow::Error::from(e)))?
        .rows_affected();
    tx.commit().await.map_err(anyhow::Error::from)?;
    if done == 0 {
        return Err(ApiError::not_found("ontology not found"));
    }
    let (concepts, synonyms) = concept_counts(&state, prefix.as_deref().unwrap_or("")).await;
    Ok(Json(json!({
        "ok": true,
        "ontology": prefix.unwrap_or_default(),
        "deletedConcepts": concepts,
        "deletedSynonyms": synonyms,
    })))
}

async fn schema_view(state: &AppState, tenant_id: Uuid, id: Uuid) -> Result<Value, ApiError> {
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, tenant_id).await?;
    let row: Option<OntologyRow> = sqlx::query_as(
        "SELECT id, name, prefix, status, schema_json, updated_at FROM ontologies WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    let row = row.ok_or_else(|| ApiError::not_found("ontology not found"))?;
    let (concept_total, synonym_total) =
        concept_counts(state, row.prefix.as_deref().unwrap_or("")).await;
    Ok(json!({
        "id": row.id,
        "ontology": row.prefix.clone().unwrap_or_default(),
        "name": row.name,
        "status": row.status,
        "stored": true,
        "conceptKinds": [],
        "conceptTotal": concept_total,
        "synonymTotal": synonym_total,
        "schema": row.schema_json,
        "updatedAt": row.updated_at.to_rfc3339_opts(SecondsFormat::Millis, true),
    }))
}

/// `GET /api/ontologies/{id}/schema`.
pub async fn get_schema(
    State(state): State<AppState>,
    user: AuthedUser,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(schema_view(&state, user.tenant_id, id).await?))
}

#[derive(Debug, Deserialize)]
pub struct SchemaBody {
    name: Option<String>,
    status: Option<String>,
    schema: Option<Value>,
}

/// `PUT /api/ontologies/{id}/schema` (admin).
pub async fn put_schema(
    State(state): State<AppState>,
    RequireAdmin(user): RequireAdmin,
    Path(id): Path<Uuid>,
    Json(body): Json<SchemaBody>,
) -> Result<Json<Value>, ApiError> {
    if let Some(s) = &body.status {
        if s != "active" && s != "draft" {
            return Err(ApiError::bad_request("status must be active or draft"));
        }
    }
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let done = sqlx::query(
        "UPDATE ontologies SET \
           name = COALESCE($2, name), \
           status = COALESCE($3, status), \
           schema_json = COALESCE($4, schema_json), \
           updated_at = now() \
         WHERE id = $1",
    )
    .bind(id)
    .bind(body.name.as_deref().map(str::trim))
    .bind(&body.status)
    .bind(&body.schema)
    .execute(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?
    .rows_affected();
    tx.commit().await.map_err(anyhow::Error::from)?;
    if done == 0 {
        return Err(ApiError::not_found("ontology not found"));
    }
    Ok(Json(schema_view(&state, user.tenant_id, id).await?))
}

#[derive(Debug, Deserialize)]
pub struct ImportBody {
    content: String,
    ontology: Option<String>,
    name: Option<String>,
    format: Option<String>,
}

/// `POST /api/ontologies/import` (admin) → load OBO Graphs JSON into concepts.
pub async fn import_ontology(
    State(state): State<AppState>,
    RequireAdmin(user): RequireAdmin,
    Json(body): Json<ImportBody>,
) -> Result<axum::response::Response, ApiError> {
    if body.content.trim().is_empty() {
        return Err(ApiError::bad_request("content is required"));
    }
    let format = body.format.clone().unwrap_or_else(|| "json".into());
    if format != "json" && format != "obo" {
        return Err(ApiError::bad_request(
            "only json/obo import is supported here; use the CLI for term lists",
        ));
    }
    let slug = slugify(body.ontology.as_deref().unwrap_or("custom"));
    if RESERVED.contains(&slug.as_str()) {
        return Err(ApiError::conflict("that ontology slug is reserved"));
    }

    let report = ontology::load_mondo_bytes(&state.stores, body.content.as_bytes())
        .await
        .map_err(|e| ApiError::bad_request(format!("ontology parse failed: {e:#}")))?;
    if report.concepts_upserted > MAX_SYNC_CONCEPTS {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "too_large",
            "too many concepts for a synchronous import; use the CLI runner",
        ));
    }

    // Register the catalog row.
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO ontologies (tenant_id, name, prefix, status) VALUES ($1, $2, $3, 'active') \
         RETURNING id",
    )
    .bind(user.tenant_id)
    .bind(body.name.as_deref().unwrap_or(&slug))
    .bind(&slug)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "ok": true,
            "format": format,
            "ontology": slug,
            "ontologyId": id,
            "concepts": report.concepts_upserted,
            "synonyms": 0,
            "edges": report.edges_upserted,
            "embeddings": 0,
        })),
    )
        .into_response())
}

#[derive(Debug, Deserialize)]
pub struct ExpandQuery {
    q: Option<String>,
}

/// `GET /api/ontology/expand?q=` → `{ query, aliases }` (concept synonyms).
pub async fn expand(
    State(state): State<AppState>,
    _user: AuthedUser,
    Query(q): Query<ExpandQuery>,
) -> Result<Json<Value>, ApiError> {
    let query = q.q.unwrap_or_default();
    if query.trim().is_empty() {
        return Err(ApiError::bad_request("q is required"));
    }
    // Lexical match → the concept's synonyms (shared table).
    let norm = ontology::normalize_label(&query);
    let mut conn = state
        .stores
        .pool
        .acquire()
        .await
        .map_err(anyhow::Error::from)?;
    let syn: Option<Value> = sqlx::query_scalar(
        "SELECT synonyms_json FROM concepts WHERE lower(pref_label) = $1 LIMIT 1",
    )
    .bind(norm)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?
    .flatten();
    let aliases: Vec<String> = syn
        .and_then(|v| {
            v.as_array().map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            })
        })
        .unwrap_or_default();
    Ok(Json(json!({ "query": query, "aliases": aliases })))
}

#[derive(Debug, Deserialize)]
pub struct TestBody {
    text: String,
    #[serde(default)]
    mentions: Option<Vec<String>>,
}

/// `POST /api/ontology/test` → link mentions to concepts.
pub async fn test(
    State(state): State<AppState>,
    _user: AuthedUser,
    Json(body): Json<TestBody>,
) -> Result<Json<Value>, ApiError> {
    if body.text.trim().is_empty() {
        return Err(ApiError::bad_request("text is required"));
    }
    let mentions = match body.mentions {
        Some(m) if !m.is_empty() => m,
        _ => candidate_mentions(&body.text),
    };
    let matches = ontology::link_mentions(&state.stores, &mentions)
        .await
        .map_err(ApiError::from)?;

    let mut entities = Vec::new();
    let mut unmatched = Vec::new();
    for (mention, m) in mentions.iter().zip(&matches) {
        match m {
            Some(cm) => entities.push(json!({
                "mention": mention,
                "conceptId": cm.concept_id,
                "prefLabel": cm.label,
                "ontology": cm.ontology,
                "score": (cm.score as f64 * 10000.0).round() / 10000.0,
                "match": if cm.score >= 1.0 { "exact" } else { "semantic" },
            })),
            None => unmatched.push(mention.clone()),
        }
    }
    Ok(Json(json!({
        "mentionsTested": mentions.len(),
        "linkedCount": entities.len(),
        "entities": entities,
        "unmatched": unmatched,
    })))
}

/// Derive candidate mentions from free text: capitalized spans + long words.
fn candidate_mentions(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for word in text.split(|c: char| !c.is_alphanumeric() && c != '-') {
        let w = word.trim();
        if w.len() < 6 {
            continue;
        }
        let is_cap = w.chars().next().map(|c| c.is_uppercase()).unwrap_or(false);
        if (is_cap || w.len() >= 6) && seen.insert(w.to_lowercase()) {
            out.push(w.to_string());
            if out.len() >= 25 {
                break;
            }
        }
    }
    out
}
