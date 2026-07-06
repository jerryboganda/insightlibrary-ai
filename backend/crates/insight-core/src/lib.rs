//! insight-core — the server-side brain of Insight Library AI.
//!
//! Linked as a library by `insight-api` (axum REST/WS/SSE) and `insight-worker`
//! (job queue). All intelligence — parsing orchestration, retrieval, ontology,
//! graph, synthesis, study engine, tutor — lives here; clients stay thin.

pub mod analytics;
pub mod billing;
pub mod collab;
pub mod eval;
pub mod export;
pub mod graph;
pub mod ingest;
pub mod llm;
pub mod ontology;
pub mod retrieve;
pub mod storage;
pub mod study;
pub mod synth;
pub mod tenancy;
pub mod tutor;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    #[test]
    fn version_is_set() {
        assert!(!crate::VERSION.is_empty());
    }
}
