//! Copilot (`POST /api/copilot`, SSE). 13 answering modes; grounded modes pull
//! context from the referenced topic or hybrid search. Emits the contract SSE
//! frames `{type:'token'|'citation'|'done'|'error', value}`. Metered + budget
//! gated. `x-ai-oauth-token` is accepted (desktop ChatGPT) — v1 routes through
//! the org's configured provider.

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use crate::auth::AuthedUser;
use crate::error::ApiError;
use crate::state::AppState;
use insight_core::llm::{self, Task};
use insight_core::settings;
use insight_core::storage::set_tenant;

#[derive(Debug, Deserialize)]
pub struct Attachment {
    kind: String,
    id: String,
    #[allow(dead_code)]
    label: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CopilotBody {
    mode: String,
    message: String,
    #[serde(default)]
    topic_id: Option<String>,
    #[serde(default)]
    attachment: Option<Attachment>,
}

const VALID_MODES: &[&str] = &[
    "ask",
    "strict_citation",
    "research",
    "compare",
    "contradiction",
    "study",
    "teacher",
    "exam",
    "summarize",
    "deep_reasoning",
    "fast_answer",
    "ssot",
    "delta",
];

/// Modes whose answers must be grounded in retrieved evidence.
fn is_grounded(mode: &str) -> bool {
    matches!(
        mode,
        "strict_citation" | "ssot" | "research" | "compare" | "contradiction" | "delta"
    )
}

/// Built-in per-mode system prompt (overridable via org
/// `copilotPromptOverrides[mode]`).
fn base_prompt(mode: &str) -> &'static str {
    match mode {
        "strict_citation" => {
            "Answer ONLY using the provided context. Every sentence must be \
            supported by it; if the context is insufficient, say so plainly. Cite the source ids."
        }
        "ssot" => {
            "Answer as the single source of truth for this topic, using only the provided \
            topic evidence. Be precise and non-redundant."
        }
        "research" => {
            "You are a research assistant. Synthesize the provided context into a \
            structured, well-reasoned answer with clear sections."
        }
        "compare" => {
            "Compare and contrast the entities in the question using the provided \
            context. Prefer a concise structured comparison."
        }
        "contradiction" => {
            "Identify agreements and contradictions across the provided context. \
            Flag any conflicting claims explicitly."
        }
        "delta" => {
            "Summarize what is NEW or changed relative to prior knowledge, using the \
            provided context."
        }
        "study" => {
            "You are a study coach. Explain clearly and check understanding with a short \
            question at the end."
        }
        "teacher" => "You are a patient teacher. Explain from first principles with an example.",
        "exam" => {
            "Answer as if writing a high-yield exam explanation: concise, precise, \
            testable facts first."
        }
        "summarize" => "Summarize the answer succinctly in a few bullet points.",
        "deep_reasoning" => {
            "Reason step by step and show the key inferences before the final \
            answer."
        }
        "fast_answer" => "Give the shortest correct answer with no preamble.",
        _ => "You are a helpful knowledge assistant. Answer clearly and accurately.",
    }
}

/// Resolve the effective system prompt (override wins).
fn system_prompt(cfg: &serde_json::Value, mode: &str) -> String {
    cfg.get("copilotPromptOverrides")
        .and_then(|o| o.get(mode))
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| base_prompt(mode).to_string())
}

/// Gather grounding context for the question.
async fn gather_context(state: &AppState, tenant_id: uuid::Uuid, body: &CopilotBody) -> String {
    // Topic-grounded: pull the topic's page + claims.
    let topic_ref = body.topic_id.clone().or_else(|| {
        body.attachment
            .as_ref()
            .filter(|a| a.kind == "topic")
            .map(|a| a.id.clone())
    });
    if let Some(tid) = topic_ref.and_then(|s| s.parse::<uuid::Uuid>().ok()) {
        if let Ok(mut tx) = state.stores.pool.begin().await {
            if set_tenant(&mut tx, tenant_id).await.is_ok() {
                let page: Option<String> =
                    sqlx::query_scalar("SELECT current_page_md FROM topics WHERE id = $1")
                        .bind(tid)
                        .fetch_optional(&mut *tx)
                        .await
                        .ok()
                        .flatten();
                let claims: Vec<String> = sqlx::query_scalar(
                    "SELECT c.claim_text FROM claims c JOIN topics t \
                       ON t.canonical_concept_id = c.canonical_concept_id \
                     WHERE t.id = $1 LIMIT 40",
                )
                .bind(tid)
                .fetch_all(&mut *tx)
                .await
                .unwrap_or_default();
                let _ = tx.commit().await;
                let mut ctx = page.unwrap_or_default();
                if !claims.is_empty() {
                    ctx.push_str("\n\nClaims:\n- ");
                    ctx.push_str(&claims.join("\n- "));
                }
                if !ctx.trim().is_empty() {
                    return ctx.chars().take(6000).collect();
                }
            }
        }
    }
    // Otherwise hybrid-search the message.
    match insight_core::retrieve::search(&state.stores, tenant_id, &body.message, 8).await {
        Ok(hits) => hits
            .iter()
            .map(|h| format!("- {}", h.snippet))
            .collect::<Vec<_>>()
            .join("\n")
            .chars()
            .take(6000)
            .collect(),
        Err(_) => String::new(),
    }
}

fn frame(kind: &str, value: &str) -> Event {
    Event::default().data(json!({ "type": kind, "value": value }).to_string())
}

/// `POST /api/copilot` → SSE stream of answer tokens.
pub async fn copilot(
    State(state): State<AppState>,
    user: AuthedUser,
    Json(body): Json<CopilotBody>,
) -> Result<axum::response::Response, ApiError> {
    if !VALID_MODES.contains(&body.mode.as_str()) {
        return Err(ApiError::bad_request("invalid copilot request"));
    }
    if body.message.trim().is_empty() {
        return Err(ApiError::bad_request("message is required"));
    }

    // Budget gate: refuse interactive calls once over the hard limit.
    if let Ok(status) = llm::budget_status(&state.stores, user.tenant_id).await {
        if status.over_limit {
            let stream = futures::stream::iter(vec![
                Ok::<_, std::convert::Infallible>(frame("error", "monthly AI budget exceeded")),
                Ok(frame("done", "")),
            ]);
            return Ok(Sse::new(stream)
                .keep_alive(KeepAlive::default())
                .into_response());
        }
    }

    let cfg = state.stores.settings.resolve_org(user.tenant_id).await?;
    let system = system_prompt(&cfg, &body.mode);
    let user_prompt = if is_grounded(&body.mode) {
        let context = gather_context(&state, user.tenant_id, &body).await;
        format!("Context:\n{context}\n\nQuestion: {}", body.message)
    } else {
        body.message.clone()
    };

    // Non-streaming completion, emitted as SSE token frames. (True token
    // streaming is a later refinement; the frame contract is identical.)
    let answer = match llm::complete_metered(
        &state.stores,
        user.tenant_id,
        Some(user.user_id),
        Task::Chat,
        &system,
        &user_prompt,
    )
    .await
    {
        Ok(c) => c.text,
        Err(e) => {
            let msg = format!("{e:#}");
            let stream = futures::stream::iter(vec![
                Ok::<_, std::convert::Infallible>(frame("error", &msg)),
                Ok(frame("done", "")),
            ]);
            return Ok(Sse::new(stream)
                .keep_alive(KeepAlive::default())
                .into_response());
        }
    };

    // Chunk the answer into token-ish frames so the UI renders progressively.
    let mut events: Vec<Result<Event, std::convert::Infallible>> = Vec::new();
    for piece in chunk_answer(&answer) {
        events.push(Ok(frame("token", &piece)));
    }
    events.push(Ok(frame("done", "")));
    let _ = settings::org_bool(&cfg, "strictCitationDefault", true); // reserved
    Ok(Sse::new(futures::stream::iter(events))
        .keep_alive(KeepAlive::default())
        .into_response())
}

/// Split into ~sentence-sized pieces for progressive rendering.
fn chunk_answer(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for word in text.split_inclusive(char::is_whitespace) {
        cur.push_str(word);
        if cur.len() >= 40 {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    if out.is_empty() {
        out.push(text.to_string());
    }
    out
}
