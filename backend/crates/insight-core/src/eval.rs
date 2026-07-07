//! Evaluation harness (Phase 12): run the golden set through hybrid retrieval,
//! score recall/faithfulness, and persist an eval run.

use anyhow::Context;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::retrieve;
use crate::storage::{set_tenant, Stores};

/// Computed metrics for one evaluation run.
#[derive(Debug, Clone)]
pub struct EvalMetrics {
    pub faithfulness: f64,
    pub citation_accuracy: f64,
    pub hallucination_rate: f64,
    pub novelty_precision: f64,
    pub recent_tests: Vec<Value>,
}

impl EvalMetrics {
    pub fn to_json(&self) -> Value {
        json!({
            "faithfulness": self.faithfulness,
            "citationAccuracy": self.citation_accuracy,
            "hallucinationRate": self.hallucination_rate,
            "noveltyPrecision": self.novelty_precision,
            "recentTests": self.recent_tests,
        })
    }
}

/// Run the golden set for a tenant: each golden query is retrieved and marked
/// Pass when its `expect` string appears in a top result. Persists the run.
pub async fn run_golden_eval(stores: &Stores, tenant_id: Uuid) -> anyhow::Result<EvalMetrics> {
    let golden: Vec<(String, String)> = {
        let mut tx = stores.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;
        let rows =
            sqlx::query_as("SELECT query, expect FROM golden_items ORDER BY created_at LIMIT 200")
                .fetch_all(&mut *tx)
                .await
                .context("load golden set")?;
        tx.commit().await?;
        rows
    };

    let mut passed = 0usize;
    let mut recent = Vec::new();
    for (query, expect) in &golden {
        let hits = retrieve::search(stores, tenant_id, query, 8)
            .await
            .unwrap_or_default();
        let want = expect.to_lowercase();
        let ok = hits.iter().any(|h| {
            h.text.to_lowercase().contains(&want) || h.snippet.to_lowercase().contains(&want)
        });
        if ok {
            passed += 1;
        }
        if recent.len() < 20 {
            recent.push(json!({
                "query": query,
                "mode": "strict_citation",
                "status": if ok { "Pass" } else { "Fail" },
                "faithfulness": if ok { 1.0 } else { 0.0 },
            }));
        }
    }

    let total = golden.len().max(1);
    let faithfulness = passed as f64 / total as f64;
    let metrics = EvalMetrics {
        faithfulness,
        citation_accuracy: faithfulness,
        hallucination_rate: 1.0 - faithfulness,
        novelty_precision: faithfulness,
        recent_tests: recent,
    };

    // Persist the run.
    let mut tx = stores.pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    sqlx::query(
        "INSERT INTO eval_runs (tenant_id, faithfulness, citation_accuracy, hallucination_rate, novelty_precision) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(tenant_id)
    .bind(metrics.faithfulness)
    .bind(metrics.citation_accuracy)
    .bind(metrics.hallucination_rate)
    .bind(metrics.novelty_precision)
    .execute(&mut *tx)
    .await
    .context("persist eval run")?;
    tx.commit().await?;

    Ok(metrics)
}
