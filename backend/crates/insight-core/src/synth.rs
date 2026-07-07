//! Topic synthesis (Phase 10): compile a Single-Source-of-Truth markdown page
//! for a concept/topic from its grounded claims (LLM synthesis task), with
//! versioning; plus teaching-case + flashcard generation. Degrades to a plain
//! bulleted evidence list when no LLM provider is configured.

use anyhow::Context;
use uuid::Uuid;

use crate::llm::{self, Task};
use crate::storage::{set_tenant, Stores};

/// Result of a compile/regenerate pass.
#[derive(Debug, Default, Clone)]
pub struct SynthResult {
    pub topic_id: Option<Uuid>,
    pub claims: usize,
    pub version: i32,
    pub faithfulness: f64,
}

/// Minimum grounded claims a concept needs before it earns a topic.
const MIN_CLAIMS_FOR_TOPIC: i64 = 2;

const SYNTH_SYSTEM: &str = "You write a concise, well-structured markdown reference page \
    (a single source of truth) from a list of verified claims. Use short sections with \
    headings. Every statement MUST be supported by the provided claims — do not add outside \
    facts. No preamble.";

/// Compile/refresh topics for every concept that has enough grounded claims.
/// Returns the number of topics compiled.
pub async fn compile_topics(stores: &Stores, tenant_id: Uuid) -> anyhow::Result<usize> {
    let concepts: Vec<(Uuid, String, i64)> = {
        let mut tx = stores.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;
        let rows = sqlx::query_as(
            "SELECT canonical_concept_id, \
                    COALESCE(canonical_topic, '(concept)') AS label, count(*) AS n \
             FROM claims \
             WHERE canonical_concept_id IS NOT NULL AND status IN ('pending','active','accepted') \
             GROUP BY 1, 2 HAVING count(*) >= $1",
        )
        .bind(MIN_CLAIMS_FOR_TOPIC)
        .fetch_all(&mut *tx)
        .await
        .context("concepts eligible for topics")?;
        tx.commit().await?;
        rows
    };

    let mut compiled = 0usize;
    for (concept_id, label, _n) in concepts {
        let topic_id = ensure_topic(stores, tenant_id, concept_id, &label).await?;
        if synthesize(stores, tenant_id, topic_id).await.is_ok() {
            compiled += 1;
        }
    }
    Ok(compiled)
}

/// Ensure a topic row exists for a concept; returns its id.
async fn ensure_topic(
    stores: &Stores,
    tenant_id: Uuid,
    concept_id: Uuid,
    title: &str,
) -> anyhow::Result<Uuid> {
    let mut tx = stores.pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    let existing: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM topics WHERE canonical_concept_id = $1")
            .bind(concept_id)
            .fetch_optional(&mut *tx)
            .await
            .context("lookup topic by concept")?;
    let id = match existing {
        Some(id) => id,
        None => sqlx::query_scalar(
            "INSERT INTO topics (tenant_id, canonical_concept_id, title) \
             VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(tenant_id)
        .bind(concept_id)
        .bind(title)
        .fetch_one(&mut *tx)
        .await
        .context("insert topic")?,
    };
    tx.commit().await?;
    Ok(id)
}

/// Gather a topic's claim texts (via its concept).
async fn topic_claims(
    stores: &Stores,
    tenant_id: Uuid,
    topic_id: Uuid,
) -> anyhow::Result<Vec<String>> {
    let mut tx = stores.pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    let texts: Vec<String> = sqlx::query_scalar(
        "SELECT c.claim_text FROM claims c \
         JOIN topics t ON t.canonical_concept_id = c.canonical_concept_id \
         WHERE t.id = $1 AND c.status <> 'duplicate' \
         ORDER BY c.created_at LIMIT 60",
    )
    .bind(topic_id)
    .fetch_all(&mut *tx)
    .await
    .context("gather topic claims")?;
    tx.commit().await?;
    Ok(texts)
}

/// (Re)synthesize a topic's page from its claims, writing a new version.
pub async fn synthesize(
    stores: &Stores,
    tenant_id: Uuid,
    topic_id: Uuid,
) -> anyhow::Result<SynthResult> {
    let claims = topic_claims(stores, tenant_id, topic_id).await?;
    if claims.is_empty() {
        anyhow::bail!("no claims to synthesize for topic {topic_id}");
    }

    let evidence = claims
        .iter()
        .enumerate()
        .map(|(i, c)| format!("[{}] {c}", i + 1))
        .collect::<Vec<_>>()
        .join("\n");

    // LLM synthesis; fall back to a plain evidence list with no provider.
    let page_md = match llm::complete_metered(
        stores,
        tenant_id,
        None,
        Task::Synthesis,
        SYNTH_SYSTEM,
        &format!("Claims:\n{evidence}\n\nWrite the reference page."),
    )
    .await
    {
        Ok(c) => c.text,
        Err(_) => format!(
            "## Summary\n\n{}",
            claims
                .iter()
                .map(|c| format!("- {c}"))
                .collect::<Vec<_>>()
                .join("\n")
        ),
    };

    // faithfulness v1: fraction of claims whose text appears (loosely) in the page.
    let lower = page_md.to_lowercase();
    let covered = claims
        .iter()
        .filter(|c| {
            let key: String = c
                .to_lowercase()
                .split_whitespace()
                .take(4)
                .collect::<Vec<_>>()
                .join(" ");
            !key.is_empty() && lower.contains(&key)
        })
        .count();
    let faithfulness = covered as f64 / claims.len() as f64;

    // Bump version + persist page + append a version row.
    let mut tx = stores.pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    let version: i32 = sqlx::query_scalar(
        "UPDATE topics SET current_page_md = $2, version = version + 1, updated_at = now() \
         WHERE id = $1 RETURNING version",
    )
    .bind(topic_id)
    .bind(&page_md)
    .fetch_one(&mut *tx)
    .await
    .context("update topic page")?;
    sqlx::query(
        "INSERT INTO topic_versions (topic_id, tenant_id, version, page_md, changelog) \
         VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT (topic_id, version) DO UPDATE SET page_md = $4, changelog = $5",
    )
    .bind(topic_id)
    .bind(tenant_id)
    .bind(version)
    .bind(&page_md)
    .bind("evidence recompose")
    .execute(&mut *tx)
    .await
    .context("insert topic version")?;
    tx.commit().await?;

    Ok(SynthResult {
        topic_id: Some(topic_id),
        claims: claims.len(),
        version,
        faithfulness,
    })
}

/// Restore a topic to a prior version's page (append-only: writes a new version).
pub async fn restore_version(
    stores: &Stores,
    tenant_id: Uuid,
    topic_id: Uuid,
    from_version: i32,
) -> anyhow::Result<SynthResult> {
    let mut tx = stores.pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    let page: Option<String> = sqlx::query_scalar(
        "SELECT page_md FROM topic_versions WHERE topic_id = $1 AND version = $2",
    )
    .bind(topic_id)
    .bind(from_version)
    .fetch_optional(&mut *tx)
    .await
    .context("load version to restore")?;
    let Some(page) = page else {
        tx.commit().await.ok();
        anyhow::bail!("version {from_version} not found");
    };
    let version: i32 = sqlx::query_scalar(
        "UPDATE topics SET current_page_md = $2, version = version + 1, updated_at = now() \
         WHERE id = $1 RETURNING version",
    )
    .bind(topic_id)
    .bind(&page)
    .fetch_one(&mut *tx)
    .await
    .context("restore topic page")?;
    sqlx::query(
        "INSERT INTO topic_versions (topic_id, tenant_id, version, page_md, changelog) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(topic_id)
    .bind(tenant_id)
    .bind(version)
    .bind(&page)
    .bind(format!("restored from v{from_version}"))
    .execute(&mut *tx)
    .await
    .context("record restore version")?;
    tx.commit().await?;
    Ok(SynthResult {
        topic_id: Some(topic_id),
        claims: 0,
        version,
        faithfulness: 1.0,
    })
}

/// Generate a teaching vignette from a topic's claims.
pub async fn generate_case(
    stores: &Stores,
    tenant_id: Uuid,
    topic_id: Uuid,
) -> anyhow::Result<String> {
    let claims = topic_claims(stores, tenant_id, topic_id).await?;
    anyhow::ensure!(!claims.is_empty(), "no evidence for a case");
    let evidence = claims.join("\n- ");
    let out = llm::complete_metered(
        stores,
        tenant_id,
        None,
        Task::Synthesis,
        "You write a short clinical/teaching vignette that exercises the given facts. \
         Ground it only in those facts. End with 2-3 study questions.",
        &format!("Facts:\n- {evidence}\n\nWrite the case."),
    )
    .await
    .context("case generation")?;
    Ok(out.text)
}

/// Generate up to `count` flashcards from a topic's claims. Returns the number
/// created.
pub async fn generate_flashcards(
    stores: &Stores,
    tenant_id: Uuid,
    topic_id: Uuid,
    count: usize,
) -> anyhow::Result<usize> {
    let claims = topic_claims(stores, tenant_id, topic_id).await?;
    if claims.is_empty() {
        return Ok(0);
    }
    let n = count.clamp(1, 50).min(claims.len());
    let mut created = 0usize;
    let mut tx = stores.pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    for claim in claims.iter().take(n) {
        // Q/A cloze v1: the claim is the answer; a simple prompt is the front.
        let front = format!("What is true regarding: {}?", first_words(claim, 8));
        sqlx::query(
            "INSERT INTO flashcards (tenant_id, topic_id, front, back) VALUES ($1, $2, $3, $4)",
        )
        .bind(tenant_id)
        .bind(topic_id)
        .bind(&front)
        .bind(claim)
        .execute(&mut *tx)
        .await
        .context("insert flashcard")?;
        created += 1;
    }
    tx.commit().await?;
    Ok(created)
}

fn first_words(s: &str, n: usize) -> String {
    s.split_whitespace().take(n).collect::<Vec<_>>().join(" ")
}
