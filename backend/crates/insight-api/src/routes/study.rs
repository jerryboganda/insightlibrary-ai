//! Study engine routes: flashcards (list + SM-2 review) and MCQs (list with
//! answer-key stripping, generate, attempt, publish). Shapes match the
//! api-client (`Flashcard`, `Mcq`, review/attempt results).

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
use insight_core::study;
use insight_core::tenancy::role_rank;

fn is_editor(user: &AuthedUser) -> bool {
    role_rank(&user.role) >= role_rank("editor")
}

// ------------------------------------------------------------------ flashcards

#[derive(Debug, Deserialize)]
pub struct FlashcardQuery {
    topic_id: Option<String>,
}

/// `GET /api/flashcards[?topicId]` → `{ items, total }`.
pub async fn list_flashcards(
    State(state): State<AppState>,
    user: AuthedUser,
    Query(q): Query<FlashcardQuery>,
) -> Result<Json<Value>, ApiError> {
    let topic_filter = q.topic_id.and_then(|s| s.parse::<Uuid>().ok());
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    #[derive(sqlx::FromRow)]
    struct Row {
        id: Uuid,
        topic_id: Option<Uuid>,
        topic: Option<String>,
        front: String,
        back: String,
        source_claim_id: Option<Uuid>,
        due_at: Option<chrono::DateTime<chrono::Utc>>,
        fsrs_state_json: Option<Value>,
    }
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT f.id, f.topic_id, t.title AS topic, f.front, f.back, f.source_claim_id, \
                cs.due_at, cs.fsrs_state_json \
         FROM flashcards f \
         LEFT JOIN topics t ON t.id = f.topic_id \
         LEFT JOIN card_schedules cs ON cs.card_id = f.id AND cs.user_id = $2 \
         WHERE ($1::uuid IS NULL OR f.topic_id = $1) \
         ORDER BY f.id LIMIT 500",
    )
    .bind(topic_filter)
    .bind(user.user_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;

    let items: Vec<Value> = rows
        .iter()
        .map(|r| {
            let st = r.fsrs_state_json.clone().unwrap_or_else(|| json!({}));
            json!({
                "id": r.id,
                "topicId": r.topic_id.map(|x| x.to_string()).unwrap_or_default(),
                "topic": r.topic.clone().unwrap_or_default(),
                "front": r.front,
                "back": r.back,
                "sourceClaimId": r.source_claim_id,
                "dueAt": r.due_at.map(|d| d.to_rfc3339_opts(SecondsFormat::Millis, true)),
                "intervalDays": st.get("intervalDays"),
                "easeFactor": st.get("easeFactor"),
                "repetitions": st.get("repetitions"),
                "lapses": st.get("lapses"),
                "state": st.get("state"),
            })
        })
        .collect();
    let total = items.len();
    Ok(Json(json!({ "items": items, "total": total })))
}

#[derive(Debug, Deserialize)]
pub struct ReviewBody {
    grade: u8,
}

/// `POST /api/flashcards/{id}/review` → SM-2 next state.
pub async fn review_flashcard(
    State(state): State<AppState>,
    user: AuthedUser,
    Path(id): Path<Uuid>,
    Json(body): Json<ReviewBody>,
) -> Result<Json<Value>, ApiError> {
    if !(1..=4).contains(&body.grade) {
        return Err(ApiError::bad_request("grade must be 1..4"));
    }
    let next = study::review_flashcard(&state.stores, user.tenant_id, user.user_id, id, body.grade)
        .await
        .map_err(ApiError::from)?;
    let due_at = chrono::Utc::now() + chrono::Duration::days(next.due_in_days);
    Ok(Json(json!({
        "ok": true,
        "intervalDays": next.interval_days,
        "easeFactor": next.ease_factor,
        "repetitions": next.repetitions,
        "lapses": next.lapses,
        "state": next.state,
        "dueAt": due_at.to_rfc3339_opts(SecondsFormat::Millis, true),
    })))
}

// ------------------------------------------------------------------------ mcqs

#[derive(sqlx::FromRow)]
struct McqRow {
    id: Uuid,
    topic_id: Option<Uuid>,
    source_claim_id: Option<Uuid>,
    stem: String,
    options_json: Value,
    answer: String,
    rationale: Option<String>,
    difficulty: Option<String>,
    status: String,
}

/// Serialize an MCQ; strips the answer key for non-editors.
fn mcq_json(m: &McqRow, editor: bool) -> Value {
    let opts: Vec<String> = m
        .options_json
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let options: Vec<Value> = opts
        .iter()
        .enumerate()
        .map(|(i, t)| json!({ "id": format!("o{i}"), "text": t }))
        .collect();
    let correct_id = opts
        .iter()
        .position(|t| t == &m.answer)
        .map(|i| format!("o{i}"));
    let mut o = json!({
        "id": m.id,
        "topicId": m.topic_id.map(|x| x.to_string()).unwrap_or_default(),
        "claimId": m.source_claim_id,
        "stem": m.stem,
        "options": options,
        "difficulty": m.difficulty.clone().unwrap_or_else(|| "medium".into()),
        "examTags": [],
        "status": m.status,
    });
    if editor {
        o["correctOptionId"] = json!(correct_id);
        o["explanation"] = json!(m.rationale);
    }
    o
}

async fn topic_stats(
    state: &AppState,
    tenant_id: Uuid,
    user_id: Uuid,
    topic_id: Uuid,
) -> Option<Value> {
    let mut tx = state.stores.pool.begin().await.ok()?;
    set_tenant(&mut tx, tenant_id).await.ok()?;
    let row: Option<(i64, i64)> = sqlx::query_as(
        "SELECT count(*), count(*) FILTER (WHERE qa.correct) FROM quiz_attempts qa \
         JOIN mcqs m ON m.id = qa.mcq_id \
         WHERE m.topic_id = $1 AND qa.user_id = $2",
    )
    .bind(topic_id)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await
    .ok()?;
    tx.commit().await.ok()?;
    let (attempts, correct) = row.unwrap_or((0, 0));
    let accuracy = if attempts > 0 {
        correct as f64 / attempts as f64
    } else {
        0.0
    };
    Some(json!({ "attempts": attempts, "correct": correct, "accuracy": accuracy }))
}

#[derive(Debug, Deserialize)]
pub struct McqQuery {
    topic_id: Option<String>,
    status: Option<String>,
}

/// `GET /api/mcqs[?topicId&status]` → `{ items, stats?, total }`.
pub async fn list_mcqs(
    State(state): State<AppState>,
    user: AuthedUser,
    Query(q): Query<McqQuery>,
) -> Result<Json<Value>, ApiError> {
    let editor = is_editor(&user);
    let topic_filter = q.topic_id.clone().and_then(|s| s.parse::<Uuid>().ok());
    // Draft gate: non-editors only ever see published.
    let status_filter: Option<String> = if editor {
        match q.status.as_deref() {
            Some("all") | None => None,
            Some(s) => Some(s.to_string()),
        }
    } else {
        Some("published".to_string())
    };

    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let rows: Vec<McqRow> = sqlx::query_as(
        "SELECT id, topic_id, source_claim_id, stem, options_json, answer, rationale, \
                difficulty, status FROM mcqs \
         WHERE ($1::uuid IS NULL OR topic_id = $1) \
           AND ($2::text IS NULL OR status = $2) \
         ORDER BY id LIMIT 500",
    )
    .bind(topic_filter)
    .bind(&status_filter)
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;

    let items: Vec<Value> = rows.iter().map(|m| mcq_json(m, editor)).collect();
    let total = items.len();
    let stats = match topic_filter {
        Some(tid) => topic_stats(&state, user.tenant_id, user.user_id, tid).await,
        None => None,
    };
    Ok(Json(
        json!({ "items": items, "stats": stats, "total": total }),
    ))
}

#[derive(Debug, Deserialize)]
pub struct GenerateMcqBody {
    topic_id: String,
    count: Option<usize>,
}

/// `POST /api/mcqs` → `{ generated, status }`.
pub async fn generate_mcqs(
    State(state): State<AppState>,
    user: AuthedUser,
    Json(body): Json<GenerateMcqBody>,
) -> Result<Json<Value>, ApiError> {
    let topic_id = body
        .topic_id
        .parse::<Uuid>()
        .map_err(|_| ApiError::bad_request("topicId is required"))?;
    let generated = study::generate_mcqs(
        &state.stores,
        user.tenant_id,
        topic_id,
        body.count.unwrap_or(5),
    )
    .await
    .map_err(ApiError::from)?;
    Ok(Json(json!({ "generated": generated, "status": "draft" })))
}

#[derive(Debug, Deserialize)]
pub struct AttemptBody {
    option_id: String,
}

/// `POST /api/mcqs/{id}/attempt` → `{ correct, correctOptionId, explanation, stats }`.
pub async fn attempt_mcq(
    State(state): State<AppState>,
    user: AuthedUser,
    Path(id): Path<Uuid>,
    Json(body): Json<AttemptBody>,
) -> Result<Json<Value>, ApiError> {
    let editor = is_editor(&user);
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let mcq: Option<McqRow> = sqlx::query_as(
        "SELECT id, topic_id, source_claim_id, stem, options_json, answer, rationale, \
                difficulty, status FROM mcqs WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    let Some(mcq) = mcq else {
        tx.commit().await.ok();
        return Err(ApiError::not_found("mcq not found"));
    };
    if mcq.status == "draft" && !editor {
        tx.commit().await.ok();
        return Err(ApiError::not_found("mcq not found"));
    }

    let opts: Vec<String> = mcq
        .options_json
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let correct_idx = opts.iter().position(|t| t == &mcq.answer);
    let correct_id = correct_idx.map(|i| format!("o{i}")).unwrap_or_default();
    let chosen_idx = body
        .option_id
        .strip_prefix('o')
        .and_then(|s| s.parse::<usize>().ok());
    if chosen_idx.map(|i| i >= opts.len()).unwrap_or(true) {
        tx.commit().await.ok();
        return Err(ApiError::bad_request("unknown optionId"));
    }
    let correct = chosen_idx == correct_idx;

    sqlx::query(
        "INSERT INTO quiz_attempts (tenant_id, user_id, mcq_id, chosen, correct) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(user.tenant_id)
    .bind(user.user_id)
    .bind(id)
    .bind(&body.option_id)
    .bind(correct)
    .execute(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;

    let stats = match mcq.topic_id {
        Some(tid) => topic_stats(&state, user.tenant_id, user.user_id, tid).await,
        None => None,
    };
    Ok(Json(json!({
        "correct": correct,
        "correctOptionId": correct_id,
        "explanation": mcq.rationale.unwrap_or_default(),
        "stats": stats,
    })))
}

#[derive(Debug, Deserialize)]
pub struct SetStatusBody {
    status: String,
}

/// `PATCH /api/mcqs/{id}` (editor) → `{ item }`.
pub async fn set_mcq_status(
    State(state): State<AppState>,
    user: AuthedUser,
    Path(id): Path<Uuid>,
    Json(body): Json<SetStatusBody>,
) -> Result<Json<Value>, ApiError> {
    if !is_editor(&user) {
        return Err(ApiError::forbidden("requires editor role or higher"));
    }
    if body.status != "draft" && body.status != "published" {
        return Err(ApiError::bad_request("status must be draft or published"));
    }
    let mut tx = state
        .stores
        .pool
        .begin()
        .await
        .map_err(anyhow::Error::from)?;
    set_tenant(&mut tx, user.tenant_id).await?;
    let row: Option<McqRow> = sqlx::query_as(
        "UPDATE mcqs SET status = $2 WHERE id = $1 \
         RETURNING id, topic_id, source_claim_id, stem, options_json, answer, rationale, \
                   difficulty, status",
    )
    .bind(id)
    .bind(&body.status)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    tx.commit().await.map_err(anyhow::Error::from)?;
    let row = row.ok_or_else(|| ApiError::not_found("mcq not found"))?;
    Ok(Json(json!({ "item": mcq_json(&row, true) })))
}
