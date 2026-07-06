//! Upload presign + document CRUD (frontend `Document` shape) + ingest
//! enqueue with Idempotency-Key replay.

use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::SecondsFormat;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::AuthedUser;
use crate::error::ApiError;
use crate::state::AppState;
use insight_core::storage::{set_tenant, BlobStore, Cache, DocStore, DocumentRow, NewDocument};

const PRESIGN_TTL: Duration = Duration::from_secs(15 * 60);
const IDEMPOTENCY_TTL_SECS: u64 = 24 * 60 * 60;
/// Reservation marker stored under the idempotency key BEFORE any work, so a
/// concurrent/retried request with the same key cannot create a second
/// document. Cannot collide with a stored response (those are JSON objects).
const IDEMPOTENCY_PENDING: &str = "pending";
/// How long the pending reservation blocks retries when the first attempt
/// dies without storing a response (crash between reserve and finalize).
const IDEMPOTENCY_PENDING_TTL_SECS: u64 = 60;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresignBody {
    filename: String,
    #[allow(dead_code)] // Accepted for contract compat; the PUT signature does not pin it.
    content_type: Option<String>,
    #[allow(dead_code)]
    folder_id: Option<String>,
}

/// Keep `[A-Za-z0-9._-]`, replace the rest, cap the length; never let a
/// client-supplied name shape the object path.
fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(['.', '_']).to_string();
    let base = if trimmed.is_empty() {
        "file".to_string()
    } else {
        trimmed
    };
    base.chars().take(120).collect()
}

/// `POST /api/uploads/presign` → `{ url, key, method: "PUT" }`.
pub async fn presign(
    user: AuthedUser,
    State(state): State<AppState>,
    Json(body): Json<PresignBody>,
) -> Result<Json<Value>, ApiError> {
    let key = format!(
        "{}/{}-{}",
        user.tenant_id,
        Uuid::new_v4(),
        sanitize_filename(&body.filename)
    );
    let url = state
        .stores
        .blobs
        .presign_put(&state.stores.config.buckets.documents, &key, PRESIGN_TTL)
        .await?;
    Ok(Json(json!({ "url": url, "key": key, "method": "PUT" })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDocumentBody {
    /// Object key from `POST /api/uploads/presign`. The live Svelte client
    /// sends this as `storageKey` (api-client `createDocument`), so both
    /// names are accepted.
    #[serde(alias = "storageKey")]
    key: String,
    title: Option<String>,
    sha256: Option<String>,
    source_type: Option<String>,
    folder_id: Option<String>,
}

fn status_label(status: &str) -> &'static str {
    match status {
        "indexed" => "Indexed",
        "processing" | "pending" | "queued" => "Processing",
        "needs_review" => "Needs review",
        "failed" => "Failed",
        _ => "Processing",
    }
}

fn doc_type(title: &str, storage_key: &str) -> &'static str {
    let ext = |s: &str| s.rsplit('.').next().map(str::to_ascii_lowercase);
    match ext(title).or_else(|| ext(storage_key)).as_deref() {
        Some("docx") | Some("doc") => "docx",
        Some("epub") => "epub",
        _ => "pdf",
    }
}

/// Serialize a document to the frontend `Document` shape. `pages` is the real
/// persisted page count (from `SELECT count(*) FROM pages`); pass `0` only when
/// the count is genuinely unknown/not applicable (e.g. list rows where the
/// per-doc count is not fetched).
fn document_json(row: &DocumentRow, pages: i64) -> Value {
    let status = if row.status == "pending" {
        "processing"
    } else {
        row.status.as_str()
    };
    json!({
        "id": row.id,
        "folderId": row.folder_id,
        "title": row.title,
        "status": status,
        "statusLabel": status_label(status),
        "type": doc_type(&row.title, &row.storage_key),
        "pages": pages,
        // topics is still a Phase-5 placeholder (topic modeling not wired yet).
        "topics": 0,
        // use_z: the frontend schema (z.iso.datetime()) rejects `+00:00`.
        "uploadedAt": row.added_at.to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}

/// Count persisted pages for one document under the tenant RLS context.
async fn page_count(state: &AppState, tenant_id: Uuid, document_id: Uuid) -> Result<i64, ApiError> {
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, tenant_id).await?;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM pages WHERE document_id = $1")
        .bind(document_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(anyhow::Error::from)?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    Ok(count)
}

fn replayed_response(stored: String) -> Response {
    let mut response = (
        StatusCode::OK,
        [("content-type", "application/json")],
        stored,
    )
        .into_response();
    response.headers_mut().insert(
        "Idempotency-Replayed",
        "true".parse().expect("static header"),
    );
    response
}

/// `POST /api/documents` — records the uploaded object, flips it to
/// `processing`, and enqueues the ingest job. Honors `Idempotency-Key`.
pub async fn create_document(
    user: AuthedUser,
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateDocumentBody>,
) -> Result<Response, ApiError> {
    // The blob layer has no tenant dimension — refuse keys outside the
    // caller's prefix so one tenant cannot register another's object.
    let prefix = format!("{}/", user.tenant_id);
    if !body.key.starts_with(&prefix) || body.key.contains("..") {
        return Err(ApiError::bad_request("key does not belong to this tenant"));
    }

    // Two-phase idempotency: reserve the key with a `pending` marker BEFORE
    // any work. A concurrent/retried request with the same key either
    // replays the stored response or gets a 409 while the first attempt is
    // still in flight — it can never insert a second document.
    let idem_key = headers
        .get("Idempotency-Key")
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty() && v.len() <= 200)
        .map(|v| format!("idem:{}:{v}", user.tenant_id));
    if let Some(idem_key) = &idem_key {
        let reserved = state
            .stores
            .cache
            .set_nx_with_ttl(idem_key, IDEMPOTENCY_PENDING, IDEMPOTENCY_PENDING_TTL_SECS)
            .await?;
        if !reserved {
            return match state.stores.cache.get(idem_key).await? {
                Some(stored) if stored != IDEMPOTENCY_PENDING => Ok(replayed_response(stored)),
                _ => Err(ApiError::conflict(
                    "a request with this idempotency key is already in flight; retry shortly",
                )),
            };
        }
    }

    let result = create_document_inner(&user, &state, &body).await;
    match result {
        Ok(doc) => {
            let serialized = doc.to_string();
            if let Some(idem_key) = &idem_key {
                // Overwrite the pending marker with the final response.
                state
                    .stores
                    .cache
                    .set_with_ttl(idem_key, &serialized, IDEMPOTENCY_TTL_SECS)
                    .await?;
            }
            Ok((StatusCode::OK, Json(doc)).into_response())
        }
        Err(e) => {
            // Release the reservation so a retry does not wait out the
            // pending TTL (best effort — the TTL bounds a lost DEL).
            if let Some(idem_key) = &idem_key {
                if let Err(del_err) = state.stores.cache.del(idem_key).await {
                    tracing::warn!(
                        error = format!("{del_err:#}"),
                        "failed to release idempotency reservation"
                    );
                }
            }
            Err(e)
        }
    }
}

/// The actual insert + status flip + enqueue, separated so the idempotency
/// reservation above can be finalized/released on every exit path.
async fn create_document_inner(
    user: &AuthedUser,
    state: &AppState,
    body: &CreateDocumentBody,
) -> Result<Value, ApiError> {
    let title = body
        .title
        .clone()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| {
            body.key
                .rsplit('/')
                .next()
                .and_then(|name| name.split_once('-').map(|(_, rest)| rest.to_string()))
                .unwrap_or_else(|| "Untitled document".to_string())
        });

    let doc_id = state
        .stores
        .docs
        .insert_document(
            user.tenant_id,
            &NewDocument {
                storage_key: body.key.clone(),
                sha256: body.sha256.clone().unwrap_or_default(),
                title: title.clone(),
                source_type: body.source_type.clone().unwrap_or_else(|| "upload".into()),
                source_ref: None,
                license: None,
                owner: None,
                course: None,
                subject: None,
                folder_id: body.folder_id.clone(),
            },
        )
        .await?;
    state
        .stores
        .docs
        .update_document_status(user.tenant_id, doc_id, "processing")
        .await?;

    let job_id = match state
        .queue
        .enqueue(
            "ingest",
            user.tenant_id,
            &json!({ "documentId": doc_id, "userId": user.user_id }),
        )
        .await
    {
        Ok(job_id) => job_id,
        Err(e) => {
            // No job will ever pick this document up — flip it to `failed`
            // (best effort) so it cannot sit at `processing` forever.
            if let Err(mark_err) = state
                .stores
                .docs
                .update_document_status(user.tenant_id, doc_id, "failed")
                .await
            {
                tracing::error!(
                    document = %doc_id,
                    error = format!("{mark_err:#}"),
                    "failed to mark document failed after enqueue error"
                );
            }
            return Err(e.into());
        }
    };

    let row = state
        .stores
        .docs
        .get_document(user.tenant_id, doc_id)
        .await?
        .ok_or_else(|| ApiError::not_found("document vanished after insert"))?;
    // Freshly created; ingest has not run yet, so there are no pages persisted.
    let mut doc = document_json(&row, 0);
    doc["jobId"] = json!(job_id);
    Ok(doc)
}

const LIST_MAX_LIMIT: i64 = 200;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListQuery {
    folder_id: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

/// `GET /api/documents?folderId=&limit=&offset=` → `{ items: Document[],
/// total }` where `total` counts everything matching the folder filter (not
/// just this page), so clients can paginate.
pub async fn list_documents(
    user: AuthedUser,
    State(state): State<AppState>,
    Query(query): Query<ListQuery>,
) -> Result<Json<Value>, ApiError> {
    let folder_id = query.folder_id.as_deref().filter(|f| !f.is_empty());
    let limit = query
        .limit
        .unwrap_or(LIST_MAX_LIMIT)
        .clamp(1, LIST_MAX_LIMIT);
    let offset = query.offset.unwrap_or(0).max(0);

    let rows = state
        .stores
        .docs
        .list_documents(user.tenant_id, folder_id, limit, offset)
        .await?;

    let doc_ids: Vec<Uuid> = rows.iter().map(|r| r.id).collect();

    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let total: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM documents WHERE ($1::text IS NULL OR folder_id = $1)",
    )
    .bind(folder_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?;
    // Real page counts for this page of documents, in one grouped query.
    let page_counts: std::collections::HashMap<Uuid, i64> = sqlx::query_as::<_, (Uuid, i64)>(
        "SELECT document_id, count(*) FROM pages WHERE document_id = ANY($1) GROUP BY document_id",
    )
    .bind(&doc_ids)
    .fetch_all(&mut *tx)
    .await
    .map_err(anyhow::Error::from)?
    .into_iter()
    .collect();
    tx.commit().await.map_err(anyhow::Error::from)?;

    let items: Vec<Value> = rows
        .iter()
        .map(|r| document_json(r, page_counts.get(&r.id).copied().unwrap_or(0)))
        .collect();
    Ok(Json(json!({ "items": items, "total": total })))
}

/// `GET /api/documents/{id}`.
pub async fn get_document(
    user: AuthedUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let row = state
        .stores
        .docs
        .get_document(user.tenant_id, id)
        .await?
        .ok_or_else(|| ApiError::not_found("document not found"))?;
    let pages = page_count(&state, user.tenant_id, id).await?;
    Ok(Json(document_json(&row, pages)))
}
