//! Ontology grounding (Phase 6): parse a biomedical ontology release into the
//! SHARED `concepts` / `concept_edges` tables, precompute `concept_embeddings`
//! via the existing inference-svc `/embed/dense` (bge-base, 768-dim), and link
//! free-text mentions to concepts.
//!
//! # Focus ontology for the Phase 6 gate: **Mondo**
//!
//! The disease ontology Mondo (which contains Addison disease MONDO:0008170) is
//! the one loaded for the acceptance gate. [`load_mondo`] parses the official
//! Mondo **OBO Graphs JSON** release (`mondo.json`) — a top-level
//! `graphs[].nodes[]` array of `CLASS` nodes plus `graphs[].edges[]` `is_a`
//! relations. The tiny committed fixture
//! `crates/insight-worker/tests/fixtures/mondo-min.json` uses the identical
//! shape, so the loader path and the gate fixture share one parser.
//!
//! MeSH / HPO / RxNorm loaders are provided as real-but-optional stubs behind
//! the `insight-ontology` CLI; they are **not run for the gate** and each notes
//! the release format it would parse. UMLS/SNOMED are never bundled.
//!
//! # Entity linking without SapBERT
//!
//! The RAM budget on the shared 6 GB VPS forbids adding a dedicated biomedical
//! encoder. Linking therefore uses only what is already loaded:
//!   1. **Lexical**: normalize the mention (lowercase, strip punctuation,
//!      collapse whitespace) and match it exactly against a concept's
//!      `pref_label` or any entry in `synonyms_json`.
//!   2. **Embedding NN**: otherwise embed the mention with the existing
//!      inference-svc `/embed/dense` (bge-base-en-v1.5, 768-dim) and take the
//!      nearest `concept_embeddings` neighbour by cosine, gated by a threshold.
//!
//! NOTE (future quality upgrade): SapBERT (`cambridgeltl/SapBERT-*`) would give
//! markedly better entity-linking recall/precision than bge, but loading it
//! would blow the shared-box RAM budget. Keep bge here; revisit SapBERT only if
//! the box grows or inference-svc moves to a bigger host.

use anyhow::Context;
use serde::Deserialize;
use uuid::Uuid;

use crate::retrieve;
use crate::storage::Stores;

/// Concept-embedding batch size for the resumable `embed-concepts` pass. Small
/// enough to keep the inference-svc request body + peak RAM bounded on the
/// shared box, matching the ingest EMBED_BATCH ballpark.
pub const CONCEPT_EMBED_BATCH: usize = 64;

/// Cosine-similarity floor for accepting an embedding nearest-neighbour link.
/// Overridable via `LINK_SIM_THRESHOLD`. Lexical matches always win and are not
/// subject to this floor.
const DEFAULT_LINK_SIM: f32 = 0.72;

fn link_sim_threshold() -> f32 {
    std::env::var("LINK_SIM_THRESHOLD")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_LINK_SIM)
}

// ---------------------------------------------------------------------------
// OBO Graphs JSON wire types (the format of the official `mondo.json` release
// and of the committed gate fixture).
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct OboGraphDoc {
    #[serde(default)]
    graphs: Vec<OboGraph>,
}

#[derive(Debug, Deserialize)]
struct OboGraph {
    #[serde(default)]
    nodes: Vec<OboNode>,
    #[serde(default)]
    edges: Vec<OboEdge>,
}

#[derive(Debug, Deserialize)]
struct OboNode {
    id: String,
    #[serde(default)]
    lbl: Option<String>,
    #[serde(default, rename = "type")]
    node_type: Option<String>,
    #[serde(default)]
    meta: Option<OboMeta>,
}

#[derive(Debug, Deserialize)]
struct OboMeta {
    #[serde(default)]
    synonyms: Vec<OboSynonym>,
}

#[derive(Debug, Deserialize)]
struct OboSynonym {
    #[serde(default)]
    val: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OboEdge {
    sub: String,
    pred: String,
    obj: String,
}

/// A concept parsed out of an ontology release, ready to insert into the SHARED
/// `concepts` table plus its `is_a` parents (by CURIE).
#[derive(Debug, Clone)]
struct ParsedConcept {
    /// Compact URI (CURIE) form, e.g. `MONDO:0008170`.
    curie: String,
    pref_label: String,
    synonyms: Vec<String>,
}

/// Summary of a load run.
#[derive(Debug, Clone, Default)]
pub struct LoadReport {
    pub concepts_upserted: usize,
    pub edges_upserted: usize,
}

// ---------------------------------------------------------------------------
// URI / CURIE handling.
// ---------------------------------------------------------------------------

/// Turn an OBO PURL (`http://purl.obolibrary.org/obo/MONDO_0008170`) or an
/// already-compact id into a `MONDO:0008170`-style CURIE. Returns `None` for
/// ids we can't confidently normalize (e.g. blank nodes, owl builtins).
fn to_curie(raw: &str) -> Option<String> {
    let tail = raw.rsplit('/').next().unwrap_or(raw);
    // `MONDO_0008170` -> `MONDO:0008170`; also accept an already-`:`-delimited
    // CURIE. Require exactly one prefix separator so `owl#Thing` etc. drop out.
    let (prefix, local) = if let Some((p, l)) = tail.split_once('_') {
        (p, l)
    } else if let Some((p, l)) = tail.split_once(':') {
        (p, l)
    } else {
        return None;
    };
    if prefix.is_empty() || local.is_empty() || !prefix.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(format!("{}:{}", prefix.to_ascii_uppercase(), local))
}

// ---------------------------------------------------------------------------
// Normalization (shared by loader synonym storage and mention linking).
// ---------------------------------------------------------------------------

/// Normalize a label/mention for lexical matching: lowercase, replace any
/// non-alphanumeric run with a single space, trim, collapse whitespace. Also
/// strips a trailing possessive so "Addison's" ~ "Addison". Deterministic and
/// used identically on both sides of a lexical comparison.
pub fn normalize_label(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_space = true; // leading — suppress leading space
    for ch in s.chars() {
        if ch.is_alphanumeric() {
            for lc in ch.to_lowercase() {
                out.push(lc);
            }
            prev_space = false;
        } else if !prev_space {
            out.push(' ');
            prev_space = true;
        }
    }
    let trimmed = out.trim();
    // Drop a dangling possessive `s` left by stripping the apostrophe
    // ("addison s disease" -> "addison disease", "addison s" -> "addison").
    trimmed
        .split(' ')
        .filter(|tok| *tok != "s")
        .collect::<Vec<_>>()
        .join(" ")
}

// ---------------------------------------------------------------------------
// Parsing an OBO Graphs document into concepts + is_a edges.
// ---------------------------------------------------------------------------

/// Parse an OBO Graphs JSON document, keeping only nodes of the given `prefix`
/// (e.g. `"MONDO"`). Returns the concept list plus `(child_curie, parent_curie)`
/// is_a pairs where BOTH endpoints are in-prefix concepts.
fn parse_obographs(doc: &OboGraphDoc, prefix: &str) -> (Vec<ParsedConcept>, Vec<(String, String)>) {
    let prefix_up = prefix.to_ascii_uppercase();
    let mut concepts: Vec<ParsedConcept> = Vec::new();
    let mut known: std::collections::HashSet<String> = std::collections::HashSet::new();

    for graph in &doc.graphs {
        for node in &graph.nodes {
            // Only real classes (skip owl builtins / property nodes).
            if let Some(t) = &node.node_type {
                if !t.eq_ignore_ascii_case("CLASS") {
                    continue;
                }
            }
            let Some(curie) = to_curie(&node.id) else {
                continue;
            };
            if !curie.starts_with(&format!("{prefix_up}:")) {
                continue;
            }
            let Some(pref_label) = node.lbl.as_ref().filter(|l| !l.trim().is_empty()) else {
                continue;
            };
            let synonyms: Vec<String> = node
                .meta
                .as_ref()
                .map(|m| {
                    m.synonyms
                        .iter()
                        .filter_map(|s| s.val.as_ref())
                        .map(|v| v.trim().to_string())
                        .filter(|v| !v.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            known.insert(curie.clone());
            concepts.push(ParsedConcept {
                curie,
                pref_label: pref_label.trim().to_string(),
                synonyms,
            });
        }

        // Collect is_a edges between two in-prefix, known concepts.
        // (drop after we've seen every node so both endpoints resolve).
    }

    let mut edges: Vec<(String, String)> = Vec::new();
    for graph in &doc.graphs {
        for edge in &graph.edges {
            // is_a predicate appears as `is_a` or the RO/rdfs subclass IRI.
            let is_subclass = edge.pred.eq_ignore_ascii_case("is_a")
                || edge.pred.contains("subClassOf")
                || edge.pred.ends_with("#is_a");
            if !is_subclass {
                continue;
            }
            let (Some(child), Some(parent)) = (to_curie(&edge.sub), to_curie(&edge.obj)) else {
                continue;
            };
            if known.contains(&child) && known.contains(&parent) {
                edges.push((child, parent));
            }
        }
    }

    (concepts, edges)
}

// ---------------------------------------------------------------------------
// Persisting concepts + edges (SHARED tables — no tenant_id, no RLS, no
// set_tenant). Upsert so a reload is idempotent.
// ---------------------------------------------------------------------------

async fn persist_concepts(
    stores: &Stores,
    ontology: &str,
    concepts: &[ParsedConcept],
    edges: &[(String, String)],
) -> anyhow::Result<LoadReport> {
    let mut report = LoadReport::default();

    // Upsert concepts; build a CURIE -> concept UUID map for edge wiring.
    let mut id_by_curie: std::collections::HashMap<String, Uuid> = std::collections::HashMap::new();
    for c in concepts {
        let synonyms_json = serde_json::json!(c.synonyms);
        // SHARED table: plain pool connection, no set_tenant.
        let id: Uuid = sqlx::query_scalar(
            "INSERT INTO concepts (ontology, code, pref_label, synonyms_json) \
             VALUES ($1, $2, $3, $4) \
             ON CONFLICT (ontology, code) DO UPDATE SET \
               pref_label = EXCLUDED.pref_label, \
               synonyms_json = EXCLUDED.synonyms_json \
             RETURNING id",
        )
        .bind(ontology)
        .bind(&c.curie)
        .bind(&c.pref_label)
        .bind(&synonyms_json)
        .fetch_one(&stores.pool)
        .await
        .with_context(|| format!("upsert concept {}", c.curie))?;
        id_by_curie.insert(c.curie.clone(), id);
        report.concepts_upserted += 1;
    }

    // Upsert is_a edges (parent_id, child_id).
    for (child, parent) in edges {
        let (Some(&child_id), Some(&parent_id)) = (id_by_curie.get(child), id_by_curie.get(parent))
        else {
            continue;
        };
        sqlx::query(
            "INSERT INTO concept_edges (parent_id, child_id, rel) \
             VALUES ($1, $2, 'is_a') \
             ON CONFLICT (parent_id, child_id, rel) DO NOTHING",
        )
        .bind(parent_id)
        .bind(child_id)
        .execute(&stores.pool)
        .await
        .context("upsert concept_edge")?;
        report.edges_upserted += 1;
    }

    Ok(report)
}

// ---------------------------------------------------------------------------
// Loading a source (local path or https URL) into a parsed document.
// ---------------------------------------------------------------------------

/// Read an ontology release from a local filesystem path OR an `https://` URL
/// (fetched with reqwest — downloading happens ON THE VPS, never baked into the
/// image). Returns the raw JSON bytes.
async fn read_source(path_or_url: &str) -> anyhow::Result<Vec<u8>> {
    if path_or_url.starts_with("http://") || path_or_url.starts_with("https://") {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(600))
            .build()
            .context("building ontology download client")?;
        let resp = client
            .get(path_or_url)
            .send()
            .await
            .with_context(|| format!("GET {path_or_url}"))?;
        anyhow::ensure!(
            resp.status().is_success(),
            "ontology download returned {}",
            resp.status()
        );
        Ok(resp.bytes().await.context("read ontology body")?.to_vec())
    } else {
        tokio::fs::read(path_or_url)
            .await
            .with_context(|| format!("read ontology file {path_or_url}"))
    }
}

// ---------------------------------------------------------------------------
// Public loaders.
// ---------------------------------------------------------------------------

/// Load the **Mondo** disease ontology from a local `mondo.json` path or an
/// https URL into the SHARED `concepts` / `concept_edges` tables. The release
/// is the OBO Graphs JSON export. Idempotent (upsert). This is the loader
/// exercised for the Phase 6 gate.
pub async fn load_mondo(stores: &Stores, path_or_url: &str) -> anyhow::Result<LoadReport> {
    let bytes = read_source(path_or_url).await?;
    let doc: OboGraphDoc = serde_json::from_slice(&bytes)
        .context("parse Mondo OBO Graphs JSON (expected graphs[].nodes/edges)")?;
    let (concepts, edges) = parse_obographs(&doc, "MONDO");
    anyhow::ensure!(
        !concepts.is_empty(),
        "no MONDO concepts found in {path_or_url}"
    );
    let report = persist_concepts(stores, "MONDO", &concepts, &edges).await?;
    tracing::info!(
        concepts = report.concepts_upserted,
        edges = report.edges_upserted,
        "loaded Mondo"
    );
    Ok(report)
}

/// Load Mondo from raw OBO Graphs JSON bytes already in memory (used by the
/// acceptance test to seed the tiny committed fixture without a network hop).
pub async fn load_mondo_bytes(stores: &Stores, bytes: &[u8]) -> anyhow::Result<LoadReport> {
    let doc: OboGraphDoc =
        serde_json::from_slice(bytes).context("parse Mondo OBO Graphs JSON bytes")?;
    let (concepts, edges) = parse_obographs(&doc, "MONDO");
    anyhow::ensure!(!concepts.is_empty(), "no MONDO concepts in provided bytes");
    persist_concepts(stores, "MONDO", &concepts, &edges).await
}

/// **STUB (not run for the gate).** MeSH ships as ASCII/XML descriptor records
/// (`desc20xx.xml`), not OBO Graphs, so it needs a distinct descriptor parser
/// (DescriptorUI -> code, DescriptorName -> pref_label, Concept/Term ->
/// synonyms, tree numbers -> hierarchy). Wire that here when MeSH is prioritized.
pub async fn load_mesh(_stores: &Stores, _path_or_url: &str) -> anyhow::Result<LoadReport> {
    anyhow::bail!(
        "MeSH loader is a stub (not run for the Phase 6 gate): implement the MeSH \
         descriptor-XML parser (desc20xx.xml) before enabling"
    )
}

/// **STUB (not run for the gate).** HPO also publishes an OBO Graphs `hp.json`,
/// so this could reuse [`parse_obographs`] with prefix `"HP"`. Left as an
/// explicit stub so it is a deliberate, reviewed enablement rather than an
/// accidental large load.
pub async fn load_hpo(stores: &Stores, path_or_url: &str) -> anyhow::Result<LoadReport> {
    // HPO's hp.json is the same obographs shape; reuse the parser with HP prefix.
    let bytes = read_source(path_or_url).await?;
    let doc: OboGraphDoc = serde_json::from_slice(&bytes).context("parse HPO OBO Graphs JSON")?;
    let (concepts, edges) = parse_obographs(&doc, "HP");
    anyhow::ensure!(
        !concepts.is_empty(),
        "no HP concepts found in {path_or_url}"
    );
    tracing::warn!("loading HPO (stub loader — not part of the Phase 6 gate)");
    persist_concepts(stores, "HP", &concepts, &edges).await
}

/// **STUB (not run for the gate).** RxNorm ships as RRF pipe-delimited files
/// (RXNCONSO.RRF / RXNREL.RRF), not OBO Graphs, so it needs an RRF parser
/// (RXCUI -> code, STR -> labels/synonyms, RXNREL -> relations). Wire that here
/// when RxNorm is prioritized.
pub async fn load_rxnorm(_stores: &Stores, _path_or_url: &str) -> anyhow::Result<LoadReport> {
    anyhow::bail!(
        "RxNorm loader is a stub (not run for the Phase 6 gate): implement the RRF \
         parser (RXNCONSO.RRF / RXNREL.RRF) before enabling"
    )
}

// ---------------------------------------------------------------------------
// Concept embedding (resumable): embed pref_label + synonyms via inference-svc
// /embed/dense (bge, 768-dim) for concepts that lack an embedding.
// ---------------------------------------------------------------------------

/// A concept still missing an embedding.
struct UnembeddedConcept {
    id: Uuid,
    ontology: String,
    text: String,
}

/// Text embedded for a concept: pref_label plus its synonyms, so the vector
/// sits near any surface form a mention might use.
fn concept_embed_text(pref_label: &str, synonyms: &[String]) -> String {
    if synonyms.is_empty() {
        pref_label.to_string()
    } else {
        format!("{}. {}", pref_label, synonyms.join("; "))
    }
}

/// Precompute `concept_embeddings` for every SHARED concept lacking one, in
/// batches of [`CONCEPT_EMBED_BATCH`]. **Resumable**: only concepts with no row
/// in `concept_embeddings` are embedded, so a crash/re-run continues where it
/// left off. Optionally restrict to a single `ontology`. Returns the count
/// embedded this run.
pub async fn embed_concepts(stores: &Stores, ontology: Option<&str>) -> anyhow::Result<usize> {
    let mut total = 0usize;
    loop {
        // Pull the next unembedded batch (LEFT JOIN anti-join). SHARED table:
        // plain pool, no tenant scoping.
        let rows: Vec<(Uuid, String, String, Option<serde_json::Value>)> = sqlx::query_as(
            "SELECT c.id, c.ontology, c.pref_label, c.synonyms_json \
             FROM concepts c \
             LEFT JOIN concept_embeddings e ON e.concept_id = c.id \
             WHERE e.concept_id IS NULL \
               AND ($1::text IS NULL OR c.ontology = $1) \
             ORDER BY c.id \
             LIMIT $2",
        )
        .bind(ontology)
        .bind(CONCEPT_EMBED_BATCH as i64)
        .fetch_all(&stores.pool)
        .await
        .context("fetch unembedded concepts")?;

        if rows.is_empty() {
            break;
        }

        let batch: Vec<UnembeddedConcept> = rows
            .into_iter()
            .map(|(id, ontology, pref_label, syn)| {
                let synonyms: Vec<String> = syn
                    .and_then(|v| serde_json::from_value(v).ok())
                    .unwrap_or_default();
                UnembeddedConcept {
                    id,
                    ontology,
                    text: concept_embed_text(&pref_label, &synonyms),
                }
            })
            .collect();

        let texts: Vec<String> = batch.iter().map(|c| c.text.clone()).collect();
        let vectors = retrieve::embed_dense(&texts, false)
            .await
            .context("embed concept batch")?;
        anyhow::ensure!(
            vectors.len() == batch.len(),
            "concept embed batch size mismatch: got {}, expected {}",
            vectors.len(),
            batch.len()
        );

        for (concept, vector) in batch.iter().zip(vectors.iter()) {
            let v = pgvector::Vector::from(vector.clone());
            sqlx::query(
                "INSERT INTO concept_embeddings (vector, concept_id, ontology, label) \
                 VALUES ($1, $2, $3, $4)",
            )
            .bind(v)
            .bind(concept.id)
            .bind(&concept.ontology)
            .bind(&concept.text)
            .execute(&stores.pool)
            .await
            .context("insert concept embedding")?;
            total += 1;
        }
        tracing::info!(embedded = total, "concept embedding progress");
    }
    Ok(total)
}

// ---------------------------------------------------------------------------
// Entity linking.
// ---------------------------------------------------------------------------

/// A resolved link from a free-text mention to a SHARED concept.
#[derive(Debug, Clone)]
pub struct ConceptMatch {
    pub concept_id: Uuid,
    pub ontology: String,
    pub code: String,
    pub label: String,
    /// 1.0 for an exact lexical/alias hit; cosine similarity for an embedding
    /// nearest-neighbour hit.
    pub score: f32,
    /// How the match was found: `"lexical"` or `"embedding"`.
    pub method: &'static str,
}

/// Link each mention in `mentions` to a concept, returning `Some(ConceptMatch)`
/// for a confident match or `None`.
///
/// For every mention: (1) try an exact normalized lexical match against
/// `pref_label` or any `synonyms_json` entry — the highest-precision signal, so
/// it wins outright; (2) otherwise embed the mention (bge) and take the nearest
/// `concept_embeddings` neighbour by cosine, accepted only if it clears
/// [`link_sim_threshold`]. `concepts` / `concept_embeddings` are SHARED, so no
/// tenant scoping is applied.
pub async fn link_mentions(
    stores: &Stores,
    mentions: &[String],
) -> anyhow::Result<Vec<Option<ConceptMatch>>> {
    let threshold = link_sim_threshold();
    let mut out: Vec<Option<ConceptMatch>> = Vec::with_capacity(mentions.len());

    // Collect the mentions that fall through lexical matching so their
    // embeddings can be computed in one batched inference call.
    let mut fallback_idx: Vec<usize> = Vec::new();
    let mut fallback_texts: Vec<String> = Vec::new();

    for mention in mentions {
        match lexical_match(stores, mention).await? {
            Some(m) => out.push(Some(m)),
            None => {
                fallback_idx.push(out.len());
                fallback_texts.push(mention.clone());
                out.push(None); // placeholder; filled after embedding NN
            }
        }
    }

    if fallback_texts.is_empty() {
        return Ok(out);
    }

    // Embedding fallback for the unmatched mentions (best-effort: if
    // inference-svc or the concept-embedding table is unavailable/empty, these
    // simply stay None rather than erroring the whole batch).
    let vectors = match retrieve::embed_dense(&fallback_texts, true).await {
        Ok(v) if v.len() == fallback_texts.len() => v,
        Ok(_) => return Ok(out),
        Err(e) => {
            tracing::warn!(
                error = format!("{e:#}"),
                "mention embedding failed; lexical-only"
            );
            return Ok(out);
        }
    };

    for (slot, vector) in fallback_idx.into_iter().zip(vectors) {
        if let Some(m) = embedding_match(stores, &vector, threshold).await? {
            out[slot] = Some(m);
        }
    }

    Ok(out)
}

/// Exact normalized lexical match against pref_label or a synonym. Returns the
/// first concept whose pref_label OR any synonym normalizes to the same string
/// as the mention.
async fn lexical_match(stores: &Stores, mention: &str) -> anyhow::Result<Option<ConceptMatch>> {
    let norm = normalize_label(mention);
    if norm.is_empty() {
        return Ok(None);
    }

    // Candidate concepts: those whose lower(pref_label) prefix-shares the first
    // token, OR whose synonyms jsonb contains a value we might match. To stay
    // simple and correct across punctuation differences, we fetch a bounded set
    // of candidates by the first normalized token and compare normalized forms
    // in Rust (normalization is not expressible in a plain index probe once we
    // strip possessives/punctuation). The first token is highly selective.
    let first_token = norm.split(' ').next().unwrap_or(&norm);
    let like = format!("%{}%", first_token);
    let rows: Vec<(Uuid, String, String, String, Option<serde_json::Value>)> = sqlx::query_as(
        "SELECT id, ontology, code, pref_label, synonyms_json \
         FROM concepts \
         WHERE lower(pref_label) LIKE $1 \
            OR synonyms_json::text ILIKE $1 \
         LIMIT 200",
    )
    .bind(&like)
    .fetch_all(&stores.pool)
    .await
    .context("lexical candidate fetch")?;

    for (id, ontology, code, pref_label, syn) in rows {
        if normalize_label(&pref_label) == norm {
            return Ok(Some(ConceptMatch {
                concept_id: id,
                ontology,
                code,
                label: pref_label,
                score: 1.0,
                method: "lexical",
            }));
        }
        if let Some(v) = &syn {
            let synonyms: Vec<String> = serde_json::from_value(v.clone()).unwrap_or_default();
            if synonyms.iter().any(|s| normalize_label(s) == norm) {
                return Ok(Some(ConceptMatch {
                    concept_id: id,
                    ontology,
                    code,
                    label: pref_label,
                    score: 1.0,
                    method: "lexical",
                }));
            }
        }
    }
    Ok(None)
}

/// Embedding nearest-neighbour over the SHARED `concept_embeddings` (cosine),
/// accepted only if it clears `threshold`.
async fn embedding_match(
    stores: &Stores,
    vector: &[f32],
    threshold: f32,
) -> anyhow::Result<Option<ConceptMatch>> {
    let v = pgvector::Vector::from(vector.to_vec());
    let row: Option<(Uuid, String, String, String, f64)> = sqlx::query_as(
        "SELECT c.id, c.ontology, c.code, c.pref_label, \
                (e.vector <=> $1)::float8 AS distance \
         FROM concept_embeddings e \
         JOIN concepts c ON c.id = e.concept_id \
         ORDER BY e.vector <=> $1 \
         LIMIT 1",
    )
    .bind(v)
    .fetch_optional(&stores.pool)
    .await
    .context("concept embedding nearest neighbour")?;

    let Some((id, ontology, code, pref_label, distance)) = row else {
        return Ok(None);
    };
    let score = (1.0 - distance) as f32;
    if score < threshold {
        return Ok(None);
    }
    Ok(Some(ConceptMatch {
        concept_id: id,
        ontology,
        code,
        label: pref_label,
        score,
        method: "embedding",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_strips_punct_case_and_possessive() {
        assert_eq!(normalize_label("Addison's Disease"), "addison disease");
        assert_eq!(
            normalize_label("  primary   adrenal-insufficiency "),
            "primary adrenal insufficiency"
        );
        assert_eq!(normalize_label("MONDO:0008170"), "mondo 0008170");
        assert_eq!(normalize_label("Addison's"), "addison");
    }

    #[test]
    fn curie_from_purl_and_compact() {
        assert_eq!(
            to_curie("http://purl.obolibrary.org/obo/MONDO_0008170").as_deref(),
            Some("MONDO:0008170")
        );
        assert_eq!(to_curie("MONDO:0008170").as_deref(), Some("MONDO:0008170"));
        assert_eq!(to_curie("hp_0001250").as_deref(), Some("HP:0001250"));
        // Blank/builtin nodes drop out.
        assert_eq!(to_curie("http://www.w3.org/2002/07/owl#Thing"), None);
    }

    #[test]
    fn parse_obographs_keeps_prefix_and_isa() {
        let doc: OboGraphDoc = serde_json::from_str(
            r#"{"graphs":[{"nodes":[
                {"id":"http://purl.obolibrary.org/obo/MONDO_0008170","lbl":"Addison disease","type":"CLASS",
                 "meta":{"synonyms":[{"pred":"hasExactSynonym","val":"Addison's disease"}]}},
                {"id":"http://purl.obolibrary.org/obo/MONDO_0015917","lbl":"adrenal cortical hypofunction","type":"CLASS"},
                {"id":"http://purl.obolibrary.org/obo/HP_0001250","lbl":"seizure","type":"CLASS"}
              ],"edges":[
                {"sub":"http://purl.obolibrary.org/obo/MONDO_0008170","pred":"is_a","obj":"http://purl.obolibrary.org/obo/MONDO_0015917"}
              ]}]}"#,
        )
        .unwrap();
        let (concepts, edges) = parse_obographs(&doc, "MONDO");
        assert_eq!(concepts.len(), 2, "HP node excluded by prefix filter");
        assert!(concepts
            .iter()
            .any(|c| c.curie == "MONDO:0008170"
                && c.synonyms.iter().any(|s| s == "Addison's disease")));
        assert_eq!(
            edges,
            vec![("MONDO:0008170".into(), "MONDO:0015917".into())]
        );
    }
}
