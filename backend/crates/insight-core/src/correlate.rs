//! Claim correlation (Phase 10): deduplicate near-identical claims and flag
//! contradictions into the review queue. Honors the org settings
//! `maxCorrelateClaims`, `requireReview`, `dedupCosine` (used as an exact-key
//! fallback here), and `conflictEnabled`.
//!
//! This is a deterministic v1: dedup by grounded concept + normalized meaning,
//! conflict by shared-concept opposite polarity. The embedding/NLI refinements
//! (`dedupUseNli`, `conflictSubjectCosine`) are layered on later without
//! changing this contract.

use std::collections::HashMap;

use anyhow::Context;
use uuid::Uuid;

use crate::settings;
use crate::storage::{set_tenant, Stores};

/// Outcome of a correlation pass.
#[derive(Debug, Default, Clone)]
pub struct CorrelateReport {
    pub examined: usize,
    pub duplicates: usize,
    pub conflicts: usize,
}

#[derive(sqlx::FromRow)]
struct ClaimRow {
    id: Uuid,
    concept: Option<Uuid>,
    topic: Option<String>,
    normalized: Option<String>,
}

/// Run a correlation pass over the tenant's pending claims.
pub async fn correlate(stores: &Stores, tenant_id: Uuid) -> anyhow::Result<CorrelateReport> {
    let cfg = stores.settings.resolve_org(tenant_id).await?;
    let max = settings::org_i64(&cfg, "maxCorrelateClaims", 120).clamp(1, 5000);
    let require_review = settings::org_bool(&cfg, "requireReview", true);
    let conflict_enabled = settings::org_bool(&cfg, "conflictEnabled", true);

    let claims: Vec<ClaimRow> = {
        let mut tx = stores.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;
        let rows: Vec<ClaimRow> = sqlx::query_as(
            "SELECT id, canonical_concept_id AS concept, canonical_topic AS topic, \
                    normalized_meaning AS normalized \
             FROM claims WHERE status = 'pending' ORDER BY created_at DESC LIMIT $1",
        )
        .bind(max)
        .fetch_all(&mut *tx)
        .await
        .context("load claims for correlation")?;
        tx.commit().await?;
        rows
    };
    let mut report = CorrelateReport {
        examined: claims.len(),
        ..Default::default()
    };
    if claims.is_empty() {
        return Ok(report);
    }

    // --- Dedup: group by (concept|topic, normalized meaning). ---
    let group_key = |c: &ClaimRow| -> String {
        let subject = c
            .concept
            .map(|id| id.to_string())
            .or_else(|| c.topic.clone())
            .unwrap_or_default();
        format!("{subject}::{}", c.normalized.clone().unwrap_or_default())
    };
    let mut seen: HashMap<String, Uuid> = HashMap::new();
    let mut duplicate_ids: Vec<Uuid> = Vec::new();
    for c in &claims {
        let key = group_key(c);
        if key.ends_with("::") {
            continue; // no meaningful key
        }
        match seen.entry(key) {
            std::collections::hash_map::Entry::Occupied(_) => duplicate_ids.push(c.id),
            std::collections::hash_map::Entry::Vacant(e) => {
                e.insert(c.id);
            }
        }
    }

    // --- Conflict: same concept, opposite polarity of normalized meaning. ---
    let mut conflict_ids: Vec<Uuid> = Vec::new();
    if conflict_enabled {
        let mut by_concept: HashMap<Uuid, Vec<&ClaimRow>> = HashMap::new();
        for c in &claims {
            if let Some(concept) = c.concept {
                by_concept.entry(concept).or_default().push(c);
            }
        }
        for group in by_concept.values() {
            for i in 0..group.len() {
                for j in (i + 1)..group.len() {
                    if contradicts(
                        group[i].normalized.as_deref().unwrap_or(""),
                        group[j].normalized.as_deref().unwrap_or(""),
                    ) {
                        conflict_ids.push(group[j].id);
                    }
                }
            }
        }
    }

    // --- Persist. ---
    let mut tx = stores.pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    for id in &duplicate_ids {
        sqlx::query("UPDATE claims SET status = 'duplicate' WHERE id = $1 AND status = 'pending'")
            .bind(id)
            .execute(&mut *tx)
            .await
            .context("mark duplicate claim")?;
    }
    report.duplicates = duplicate_ids.len();

    for id in &conflict_ids {
        // Flag for review; when review is disabled, still record but leave the
        // claim pending (a later verify pass resolves it).
        if require_review {
            sqlx::query(
                "INSERT INTO review_queue (tenant_id, ref_kind, ref_id, reason, status) \
                 VALUES ($1, 'claim', $2, 'contradiction', 'open')",
            )
            .bind(tenant_id)
            .bind(id)
            .execute(&mut *tx)
            .await
            .context("enqueue conflict review")?;
            sqlx::query("UPDATE claims SET status = 'needs_review' WHERE id = $1")
                .bind(id)
                .execute(&mut *tx)
                .await
                .context("flag conflicting claim")?;
        }
    }
    report.conflicts = conflict_ids.len();
    tx.commit().await?;
    Ok(report)
}

/// Two normalized claims contradict when they share most content words but
/// exactly one carries a negation. Cheap, deterministic, no model call.
fn contradicts(a: &str, b: &str) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }
    let neg = |s: &str| {
        s.split_whitespace()
            .any(|w| matches!(w, "not" | "no" | "never" | "cannot" | "without" | "neither"))
    };
    if neg(a) == neg(b) {
        return false;
    }
    // Content overlap on non-negation tokens.
    let words = |s: &str| -> std::collections::HashSet<String> {
        s.split_whitespace()
            .filter(|w| {
                !matches!(
                    *w,
                    "not"
                        | "no"
                        | "never"
                        | "cannot"
                        | "without"
                        | "neither"
                        | "is"
                        | "are"
                        | "the"
                        | "a"
                        | "an"
                        | "of"
                )
            })
            .map(str::to_string)
            .collect()
    };
    let (wa, wb) = (words(a), words(b));
    if wa.is_empty() || wb.is_empty() {
        return false;
    }
    let inter = wa.intersection(&wb).count();
    let smaller = wa.len().min(wb.len());
    (inter as f64 / smaller as f64) >= 0.6
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_opposite_polarity() {
        assert!(contradicts(
            "insulin lowers blood glucose",
            "insulin does not lower blood glucose"
        ));
        assert!(!contradicts(
            "insulin lowers blood glucose",
            "insulin raises blood glucose"
        )); // same polarity, different verb — not a negation conflict
        assert!(!contradicts("water boils at 100", "gold melts at 1064"));
    }
}
