//! Study engine (Phase 10): SM-2 spaced-repetition scheduling (ported 1:1 from
//! the Node `study/scheduler.ts`) with per-user card state in
//! `card_schedules.fsrs_state_json`, plus MCQ generation from a topic's claims.

use anyhow::Context;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::llm::{self, Task};
use crate::settings;
use crate::storage::{set_tenant, Stores};

/// Prior SR state (all optional — a fresh card has none).
#[derive(Debug, Default, Clone, Deserialize)]
pub struct SrInput {
    #[serde(default)]
    pub interval_days: Option<f64>,
    #[serde(default)]
    pub ease_factor: Option<f64>,
    #[serde(default)]
    pub repetitions: Option<i64>,
    #[serde(default)]
    pub lapses: Option<i64>,
}

/// Next SR state after a review.
#[derive(Debug, Clone, Serialize)]
pub struct SrState {
    pub interval_days: f64,
    pub ease_factor: f64,
    pub repetitions: i64,
    pub lapses: i64,
    pub state: &'static str,
    /// Days from now the card is next due (the caller stamps the timestamp).
    pub due_in_days: i64,
}

/// SM-2 update. `grade`: 1 Again · 2 Hard · 3 Good · 4 Easy. Ported from
/// `scheduleSm2` — grade maps to SM-2 quality `q = grade + 1` (2..5).
pub fn schedule_sm2(prev: &SrInput, grade: u8) -> SrState {
    let q = (grade as f64) + 1.0;
    let mut ef = prev.ease_factor.unwrap_or(2.5);
    let mut reps = prev.repetitions.unwrap_or(0);
    let mut interval = prev.interval_days.unwrap_or(0.0);
    let mut lapses = prev.lapses.unwrap_or(0);
    let state: &'static str;

    if q < 3.0 {
        reps = 0;
        interval = 1.0;
        lapses += 1;
        state = "relearning";
    } else {
        ef = f64::max(1.3, ef + (0.1 - (5.0 - q) * (0.08 + (5.0 - q) * 0.02)));
        reps += 1;
        interval = if reps == 1 {
            1.0
        } else if reps == 2 {
            6.0
        } else {
            (interval * ef).round()
        };
        state = if reps <= 1 { "learning" } else { "review" };
    }
    let due_in_days = (interval.round() as i64).max(1);
    SrState {
        interval_days: interval,
        ease_factor: ef,
        repetitions: reps,
        lapses,
        state,
        due_in_days,
    }
}

/// Record a flashcard review for a user and persist the next SR state. Returns
/// the computed next state.
pub async fn review_flashcard(
    stores: &Stores,
    tenant_id: Uuid,
    user_id: Uuid,
    card_id: Uuid,
    grade: u8,
) -> anyhow::Result<SrState> {
    let mut tx = stores.pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    let prev_json: Option<serde_json::Value> = sqlx::query_scalar(
        "SELECT fsrs_state_json FROM card_schedules WHERE card_id = $1 AND user_id = $2",
    )
    .bind(card_id)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await
    .context("load card schedule")?
    .flatten();
    let prev: SrInput = prev_json
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    let next = schedule_sm2(&prev, grade.clamp(1, 4));
    let state_json = json!({
        "intervalDays": next.interval_days,
        "easeFactor": next.ease_factor,
        "repetitions": next.repetitions,
        "lapses": next.lapses,
        "state": next.state,
    });

    sqlx::query(
        "INSERT INTO card_schedules (card_id, user_id, tenant_id, fsrs_state_json, due_at) \
         VALUES ($1, $2, $3, $4, now() + ($5 || ' days')::interval) \
         ON CONFLICT (card_id, user_id) DO UPDATE \
           SET fsrs_state_json = $4, due_at = now() + ($5 || ' days')::interval",
    )
    .bind(card_id)
    .bind(user_id)
    .bind(tenant_id)
    .bind(&state_json)
    .bind(next.due_in_days.to_string())
    .execute(&mut *tx)
    .await
    .context("upsert card schedule")?;
    tx.commit().await?;
    Ok(next)
}

/// Generate up to `count` multiple-choice questions from a topic's claims via
/// the LLM. Returns the number created.
pub async fn generate_mcqs(
    stores: &Stores,
    tenant_id: Uuid,
    topic_id: Uuid,
    count: usize,
) -> anyhow::Result<usize> {
    let cfg = stores.settings.resolve_org(tenant_id).await?;
    let _ = settings::org_bool(&cfg, "requireReview", true); // reserved

    // Gather claims for the topic's concept.
    let claims: Vec<String> = {
        let mut tx = stores.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;
        let rows = sqlx::query_scalar::<_, String>(
            "SELECT c.claim_text FROM claims c \
             JOIN topics t ON t.canonical_concept_id = c.canonical_concept_id \
             WHERE t.id = $1 AND c.status <> 'duplicate' ORDER BY c.created_at LIMIT 40",
        )
        .bind(topic_id)
        .fetch_all(&mut *tx)
        .await
        .context("gather claims for mcqs")?;
        tx.commit().await?;
        rows
    };
    if claims.is_empty() {
        return Ok(0);
    }
    let n = count.clamp(1, 20);
    let system = format!(
        "Write {n} single-best-answer multiple choice questions from the given facts. Return ONLY \
         a JSON array of objects: {{\"stem\": string, \"options\": [4 strings], \"answer\": the \
         correct option string, \"rationale\": string}}. Ground everything in the facts."
    );
    let user = format!("Facts:\n- {}", claims.join("\n- "));
    let completion =
        llm::complete_metered(stores, tenant_id, None, Task::Synthesis, &system, &user)
            .await
            .context("mcq generation")?;

    #[derive(Deserialize)]
    struct GenMcq {
        stem: String,
        options: Vec<String>,
        answer: String,
        #[serde(default)]
        rationale: Option<String>,
    }
    let trimmed = completion
        .text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim();
    let slice = match (trimmed.find('['), trimmed.rfind(']')) {
        (Some(a), Some(b)) if b > a => &trimmed[a..=b],
        _ => return Ok(0),
    };
    let mcqs: Vec<GenMcq> = serde_json::from_str(slice).unwrap_or_default();
    if mcqs.is_empty() {
        return Ok(0);
    }

    let mut created = 0usize;
    let mut tx = stores.pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    for m in mcqs.into_iter().take(n) {
        if m.options.len() < 2 || m.stem.trim().is_empty() {
            continue;
        }
        sqlx::query(
            "INSERT INTO mcqs (tenant_id, topic_id, stem, options_json, answer, rationale) \
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(tenant_id)
        .bind(topic_id)
        .bind(&m.stem)
        .bind(json!(m.options))
        .bind(&m.answer)
        .bind(&m.rationale)
        .execute(&mut *tx)
        .await
        .context("insert mcq")?;
        created += 1;
    }
    tx.commit().await?;
    Ok(created)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sm2_first_good_review() {
        let s = schedule_sm2(&SrInput::default(), 3);
        assert_eq!(s.repetitions, 1);
        assert_eq!(s.interval_days, 1.0);
        assert_eq!(s.state, "learning");
    }

    #[test]
    fn sm2_again_relearns() {
        let prev = SrInput {
            interval_days: Some(10.0),
            ease_factor: Some(2.5),
            repetitions: Some(4),
            lapses: Some(0),
        };
        let s = schedule_sm2(&prev, 1);
        assert_eq!(s.repetitions, 0);
        assert_eq!(s.interval_days, 1.0);
        assert_eq!(s.lapses, 1);
        assert_eq!(s.state, "relearning");
    }

    #[test]
    fn sm2_second_review_is_six_days() {
        let prev = SrInput {
            interval_days: Some(1.0),
            ease_factor: Some(2.5),
            repetitions: Some(1),
            lapses: Some(0),
        };
        let s = schedule_sm2(&prev, 3);
        assert_eq!(s.repetitions, 2);
        assert_eq!(s.interval_days, 6.0);
    }
}
