//! Claim extraction (Phase 10): pull atomic factual claims out of a document's
//! chunks via the LLM (extraction task), persist them with source links, and
//! ground each to a shared ontology concept where possible.
//!
//! Degrades cleanly: with no LLM provider configured, extraction is skipped and
//! returns 0 (the pipeline simply produces no claims). Honors the org setting
//! `claimsMaxChunks`.

use anyhow::Context;
use serde::Deserialize;
use uuid::Uuid;

use crate::llm::{self, Task};
use crate::ontology;
use crate::settings;
use crate::storage::{set_tenant, Stores};

/// One extracted claim as returned by the model.
#[derive(Debug, Deserialize)]
struct ExtractedClaim {
    claim_text: String,
    #[serde(default)]
    subject: Option<String>,
    #[serde(default, rename = "type")]
    claim_type: Option<String>,
}

const EXTRACT_SYSTEM: &str = "You extract atomic, self-contained factual claims from a text \
    excerpt. Return ONLY a JSON array (no prose, no markdown fences) of at most 8 objects, each \
    with: \"claim_text\" (one standalone declarative sentence), \"subject\" (the main entity or \
    concept the claim is about), and \"type\" (one of fact, definition, process, comparison). \
    Only include claims explicitly supported by the text. If none, return [].";

/// A chunk to mine, with its originating block for source attribution.
struct ChunkRow {
    text: String,
    block_id: Option<Uuid>,
}

/// Extract + persist claims for one document. Returns the number inserted.
pub async fn extract_claims(
    stores: &Stores,
    tenant_id: Uuid,
    document_id: Uuid,
) -> anyhow::Result<usize> {
    let cfg = stores.settings.resolve_org(tenant_id).await?;
    let max_chunks = settings::org_i64(&cfg, "claimsMaxChunks", 60).max(0) as i64;
    if max_chunks == 0 {
        return Ok(0);
    }

    // Pull the document's chunks (with block for attribution).
    let chunks: Vec<ChunkRow> = {
        let mut tx = stores.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;
        let rows: Vec<(String, Option<Uuid>)> = sqlx::query_as(
            "SELECT c.text, c.block_id FROM chunks c \
             JOIN blocks b ON b.id = c.block_id \
             JOIN pages p ON p.id = b.page_id \
             WHERE p.document_id = $1 ORDER BY p.page_no LIMIT $2",
        )
        .bind(document_id)
        .bind(max_chunks)
        .fetch_all(&mut *tx)
        .await
        .context("load chunks for claim extraction")?;
        tx.commit().await?;
        rows.into_iter()
            .map(|(text, block_id)| ChunkRow { text, block_id })
            .collect()
    };
    if chunks.is_empty() {
        return Ok(0);
    }

    let mut inserted = 0usize;
    for chunk in &chunks {
        let excerpt: String = chunk.text.chars().take(2000).collect();
        let completion = match llm::complete_metered(
            stores,
            tenant_id,
            None,
            Task::Extraction,
            EXTRACT_SYSTEM,
            &excerpt,
        )
        .await
        {
            Ok(c) => c,
            // No provider / call failure: skip this chunk, keep going.
            Err(e) => {
                tracing::warn!(error = format!("{e:#}"), "claim extraction call failed");
                continue;
            }
        };
        let extracted = parse_claims(&completion.text);
        if extracted.is_empty() {
            continue;
        }

        // Ground each claim's subject to a concept (best-effort, batched).
        let subjects: Vec<String> = extracted
            .iter()
            .map(|c| c.subject.clone().unwrap_or_default())
            .collect();
        let matches = ontology::link_mentions(stores, &subjects)
            .await
            .unwrap_or_else(|_| vec![None; extracted.len()]);

        let mut tx = stores.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;
        for (claim, m) in extracted.iter().zip(matches) {
            let (concept_id, canonical_topic) = match &m {
                Some(cm) => (Some(cm.concept_id), Some(cm.label.clone())),
                None => (None, claim.subject.clone()),
            };
            let claim_type = claim
                .claim_type
                .clone()
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| "fact".into());
            let claim_id: Uuid = sqlx::query_scalar(
                "INSERT INTO claims \
                   (tenant_id, canonical_topic, canonical_concept_id, claim_type, claim_text, \
                    normalized_meaning, status) \
                 VALUES ($1, $2, $3, $4, $5, $6, 'pending') RETURNING id",
            )
            .bind(tenant_id)
            .bind(&canonical_topic)
            .bind(concept_id)
            .bind(&claim_type)
            .bind(&claim.claim_text)
            .bind(normalize(&claim.claim_text))
            .fetch_one(&mut *tx)
            .await
            .context("insert claim")?;

            sqlx::query(
                "INSERT INTO claim_sources (tenant_id, claim_id, document_id, block_id) \
                 VALUES ($1, $2, $3, $4)",
            )
            .bind(tenant_id)
            .bind(claim_id)
            .bind(document_id)
            .bind(chunk.block_id)
            .execute(&mut *tx)
            .await
            .context("insert claim source")?;
            inserted += 1;
        }
        tx.commit().await?;
    }
    Ok(inserted)
}

/// Best-effort parse of the model's JSON array (tolerates markdown fences and
/// leading prose before the first `[`).
fn parse_claims(raw: &str) -> Vec<ExtractedClaim> {
    let trimmed = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim();
    let slice = match (trimmed.find('['), trimmed.rfind(']')) {
        (Some(a), Some(b)) if b > a => &trimmed[a..=b],
        _ => return Vec::new(),
    };
    serde_json::from_str::<Vec<ExtractedClaim>>(slice)
        .or_else(|_| {
            // Sometimes a single object is returned; wrap it.
            serde_json::from_str::<ExtractedClaim>(slice).map(|c| vec![c])
        })
        .unwrap_or_default()
        .into_iter()
        .filter(|c| !c.claim_text.trim().is_empty())
        .collect()
}

/// Normalized meaning key for dedup grouping: lowercase, collapse whitespace,
/// strip trailing punctuation.
fn normalize(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_json_array_with_fences() {
        let raw = "```json\n[{\"claim_text\":\"Water boils at 100C.\",\"subject\":\"water\",\"type\":\"fact\"}]\n```";
        let claims = parse_claims(raw);
        assert_eq!(claims.len(), 1);
        assert_eq!(claims[0].subject.as_deref(), Some("water"));
    }

    #[test]
    fn empty_on_garbage() {
        assert!(parse_claims("no json here").is_empty());
        assert!(parse_claims("[]").is_empty());
    }

    #[test]
    fn normalize_strips_punct() {
        assert_eq!(normalize("Water boils, at 100°C!"), "water boils at 100 c");
    }
}
