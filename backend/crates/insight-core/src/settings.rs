//! Settings foundation (Phase 7).
//!
//! Three scopes of runtime-tunable configuration, each stored as a sparse JSONB
//! "overrides" blob and resolved on read against code/env defaults, then
//! clamped. This ports the Node `apps/server/src/lib/server/org-settings.ts`
//! model 1:1 — same env-var names, same defaults, same clamps — so an existing
//! deployment keeps its behavior when the store is empty.
//!
//! - **system** (super-admin): one global row. Pricing, queue tuning, rate
//!   limits, auth TTLs, pipeline caps.
//! - **org** (admin): one row per tenant. Governance/refinery/search/AI-routing
//!   knobs + workspace identity (name/logo).
//! - **user**: per-user UI preferences.
//!
//! Resolution = `defaults(env)` overlaid with the stored overrides (shallow,
//! per top-level key) then clamped. Returning a merged [`serde_json::Value`]
//! (rather than a giant typed struct) keeps this JSONB-centric and matches how
//! the frontend reads individual keys.
//!
//! A small process-local TTL cache (10s, like Node) fronts the DB so both the
//! api and the worker can read settings on hot paths cheaply; a write
//! invalidates the entry. TTL-only invalidation means the two processes
//! converge within the TTL with no pub/sub.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::Context;
use serde_json::{json, Map, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::storage::set_tenant;

/// How long a resolved-settings entry stays cached. Matches Node's 10s TTL.
const CACHE_TTL: Duration = Duration::from_secs(10);

// ---------------------------------------------------------------------------
// env helpers (defaults live in code; env overrides the code default; the
// stored blob overrides env). Mirrors org-settings.ts envNum/envBool.
// ---------------------------------------------------------------------------

fn env_str(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}
fn env_f64(key: &str, default: f64) -> f64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}
fn env_i64(key: &str, default: i64) -> i64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}
fn env_bool(key: &str, default: bool) -> bool {
    match std::env::var(key) {
        Ok(v) => matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        Err(_) => default,
    }
}

// ---------------------------------------------------------------------------
// Scope enum + defaults + clamps
// ---------------------------------------------------------------------------

/// Which settings scope a resolve/read/write targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Scope {
    System,
    Org,
    User,
}

/// Code/env defaults for the ORG scope (governance, refinery, search, AI
/// routing/models, study, copilot). Ported from org-settings.ts + the AI
/// provider registry.
fn org_defaults() -> Value {
    json!({
        // --- governance / refinery ---
        "strictCitationDefault": env_bool("STRICT_CITATION_DEFAULT", true),
        "autoSsotTopics": env_bool("AUTO_SSOT_TOPICS", true),
        "requireReview": env_bool("REQUIRE_REVIEW", true),
        "autoMergeConfidence": env_f64("AUTO_MERGE_CONFIDENCE", 0.0),
        "dedupCosine": env_f64("DEDUP_COSINE", 0.9),
        "dedupUseNli": env_bool("DEDUP_NLI", true),
        "conflictSubjectCosine": env_f64("CONFLICT_SUBJECT_COSINE", 0.55),
        "conflictEnabled": env_bool("CONFLICT_DETECT", true),
        "maxCorrelateClaims": env_i64("CORRELATE_MAX_CLAIMS", 120),
        // --- ingestion ---
        "parseMode": env_str("PARSE_MODE", "heuristic"),
        "parseAiMaxPages": env_i64("PARSE_AI_MAX_PAGES", 20),
        "claimsMaxChunks": env_i64("CLAIMS_MAX_CHUNKS", 60),
        "contextualMaxChunks": env_i64("CONTEXTUAL_MAX_CHUNKS", 150),
        "ontologyLinkMaxDistance": env_f64("ONTOLOGY_LINK_MAX_DISTANCE", 0.4),
        // --- search / retrieval ---
        "rerank": env_str("RERANK", "off"),
        "searchRrfK": env_i64("SEARCH_RRF_K", 60),
        "searchCandidates": env_i64("SEARCH_CANDIDATES", 30),
        "searchTopK": env_i64("SEARCH_TOP_K", 20),
        "searchSnippetLength": env_i64("SEARCH_SNIPPET_LENGTH", 240),
        "copilotPromptOverrides": {},
        "sourcePriorityOrder": [],
        // --- budgets ---
        "budgetMonthlyLimitUsd": env_f64("BUDGET_MONTHLY_LIMIT_USD", 0.0),
        "budgetSoftThresholdPct": env_i64("BUDGET_SOFT_THRESHOLD_PCT", 80),
        // --- AI routing / models (consumed from Phase 8) ---
        "ai": {
            "taskRouting": {
                "chat": env_str("LLM_CHAT_PROVIDER", &env_str("LLM_PROVIDER", "gemini")),
                "extraction": env_str("LLM_EXTRACTION_PROVIDER", &env_str("LLM_PROVIDER", "gemini")),
                "synthesis": env_str("LLM_SYNTHESIS_PROVIDER", &env_str("LLM_PROVIDER", "gemini")),
                "nli": env_str("LLM_NLI_PROVIDER", &env_str("LLM_PROVIDER", "gemini")),
                "rerank": env_str("LLM_RERANK_PROVIDER", &env_str("LLM_PROVIDER", "gemini")),
                "embedding": env_str("LLM_EMBEDDING_PROVIDER", "gemini"),
            },
            "fallbackOrder": env_str("CHAT_FALLBACK_ORDER", "gemini,anthropic,openai")
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>(),
            "models": {
                "gemini": env_str("GEMINI_MODEL", "gemini-2.5-flash"),
                "anthropic": env_str("ANTHROPIC_MODEL", "claude-sonnet-5"),
                "openai": env_str("OPENAI_MODEL", "gpt-4o"),
                "moonshot": env_str("MOONSHOT_MODEL", "kimi-k2-0711-preview"),
                "deepseek": env_str("DEEPSEEK_MODEL", "deepseek-chat"),
                "minimax": env_str("MINIMAX_MODEL", "MiniMax-Text-01"),
                "openai_compatible": env_str("OPENAI_COMPAT_MODEL", ""),
            },
            "baseUrls": {
                "openaiCompatible": env_str("OPENAI_COMPAT_BASE_URL", ""),
            },
            "rerankModels": {
                "cohere": env_str("COHERE_RERANK_MODEL", "rerank-english-v3.0"),
                "jina": env_str("JINA_RERANK_MODEL", "jina-reranker-v2-base-multilingual"),
            },
            "parseVendor": env_str("PARSE_VENDOR", ""),
        },
        // --- study / SRS (consumed from Phase 11) ---
        "study": {
            "scheduler": env_str("STUDY_SCHEDULER", "sm2"),
            "sm2": {
                "initialEase": env_f64("SM2_INITIAL_EASE", 2.5),
                "minEase": env_f64("SM2_MIN_EASE", 1.3),
                "firstIntervalDays": env_i64("SM2_FIRST_INTERVAL_DAYS", 1),
                "secondIntervalDays": env_i64("SM2_SECOND_INTERVAL_DAYS", 6),
            },
            "fsrs": {
                "requestRetention": env_f64("FSRS_REQUEST_RETENTION", 0.9),
                "maximumInterval": env_i64("FSRS_MAX_INTERVAL", 365),
            },
        },
    })
}

/// Clamp the known-bounded ORG numeric keys after merge (fail-safe against a
/// hand-crafted PUT). Mirrors org-settings.ts `clamp`.
fn clamp_org(v: &mut Value) {
    clamp_f64(v, "autoMergeConfidence", 0.0, 100.0);
    clamp_f64(v, "dedupCosine", 0.0, 1.0);
    clamp_f64(v, "conflictSubjectCosine", 0.0, 1.0);
    clamp_i64(v, "maxCorrelateClaims", 1, 5000);
    clamp_i64(v, "parseAiMaxPages", 1, 500);
    clamp_i64(v, "claimsMaxChunks", 1, 2000);
    clamp_i64(v, "contextualMaxChunks", 0, 5000);
    clamp_f64(v, "ontologyLinkMaxDistance", 0.0, 1.0);
    clamp_i64(v, "searchRrfK", 1, 1000);
    clamp_i64(v, "searchCandidates", 1, 500);
    clamp_i64(v, "searchTopK", 1, 200);
    clamp_i64(v, "searchSnippetLength", 40, 2000);
    clamp_f64(v, "budgetMonthlyLimitUsd", 0.0, 1_000_000.0);
    clamp_i64(v, "budgetSoftThresholdPct", 0, 100);
}

/// Code/env defaults for the SYSTEM scope (super-admin: pricing, queue, limits,
/// auth TTLs, pipeline caps). Consumed from Phases 8/9/10.
fn system_defaults() -> Value {
    json!({
        "queue": {
            "concurrency": env_i64("QUEUE_CONCURRENCY", 2),
            "maxAttempts": env_i64("QUEUE_MAX_ATTEMPTS", 3),
            "claimIdleMs": env_i64("QUEUE_CLAIM_IDLE_MS", 300_000),
            "perKindConcurrency": {},
        },
        "rateLimit": {
            "max": env_i64("RATE_LIMIT_MAX", 300),
            "windowSecs": env_i64("RATE_LIMIT_WINDOW_SECS", 60),
            "authMax": env_i64("AUTH_RATE_LIMIT_MAX", 10),
        },
        "auth": {
            "accessTtlSecs": env_i64("JWT_ACCESS_TTL_SECS", 900),
            "refreshTtlSecs": env_i64("JWT_REFRESH_TTL_SECS", 1_209_600),
        },
        "pipeline": {
            "parseMaxPages": env_i64("PARSE_MAX_PAGES", 40),
            "parseMaxFileMb": env_i64("PARSE_MAX_FILE_MB", 100),
            "lowConfThreshold": env_f64("LOW_CONF_THRESHOLD", 0.4),
            "linkSimThreshold": env_f64("LINK_SIM_THRESHOLD", 0.72),
        },
        // Pricing table (in/out USD per 1M tokens). Empty by default; the LLM
        // layer (Phase 8) ships the ported MODEL_PRICES fallback in code.
        "pricing": {
            "models": [],
            "providerFallback": {},
        },
    })
}

fn clamp_system(v: &mut Value) {
    nested_clamp_i64(v, "queue", "concurrency", 1, 64);
    nested_clamp_i64(v, "queue", "maxAttempts", 1, 20);
    nested_clamp_i64(v, "queue", "claimIdleMs", 10_000, 3_600_000);
    nested_clamp_i64(v, "rateLimit", "max", 1, 100_000);
    nested_clamp_i64(v, "rateLimit", "windowSecs", 1, 3600);
    nested_clamp_i64(v, "rateLimit", "authMax", 1, 10_000);
    nested_clamp_i64(v, "auth", "accessTtlSecs", 60, 86_400);
    nested_clamp_i64(v, "auth", "refreshTtlSecs", 3600, 31_536_000);
    nested_clamp_i64(v, "pipeline", "parseMaxPages", 1, 10_000);
    nested_clamp_i64(v, "pipeline", "parseMaxFileMb", 1, 5000);
}

/// Code defaults for the USER scope (UI preferences).
fn user_defaults() -> Value {
    json!({
        "theme": "system",
        "locale": "en",
        "defaultCopilotMode": "ask",
        "notifications": {
            "emailEnabled": false,
            "types": {
                "processing": true,
                "review": true,
                "billing": true,
                "system": true,
            },
        },
    })
}

fn defaults_for(scope: Scope) -> Value {
    match scope {
        Scope::System => system_defaults(),
        Scope::Org => org_defaults(),
        Scope::User => user_defaults(),
    }
}

/// Public accessor for a scope's pure code/env defaults (the admin UIs render
/// these as the "reset to default" baseline).
pub fn scope_defaults(scope: Scope) -> Value {
    defaults_for(scope)
}

fn clamp_for(scope: Scope, v: &mut Value) {
    match scope {
        Scope::System => clamp_system(v),
        Scope::Org => clamp_org(v),
        Scope::User => {}
    }
}

// --- clamp helpers ---------------------------------------------------------

fn clamp_f64(v: &mut Value, key: &str, lo: f64, hi: f64) {
    if let Some(n) = v.get(key).and_then(Value::as_f64) {
        v[key] = json!(n.clamp(lo, hi));
    }
}
fn clamp_i64(v: &mut Value, key: &str, lo: i64, hi: i64) {
    if let Some(n) = v.get(key).and_then(Value::as_i64) {
        v[key] = json!(n.clamp(lo, hi));
    }
}
fn nested_clamp_i64(v: &mut Value, parent: &str, key: &str, lo: i64, hi: i64) {
    if let Some(n) = v
        .get(parent)
        .and_then(|p| p.get(key))
        .and_then(Value::as_i64)
    {
        v[parent][key] = json!(n.clamp(lo, hi));
    }
}

/// Overlay `overrides` on top of `base` (shallow, per top-level key), then
/// clamp. This is the merge Node does: a stored top-level key fully replaces
/// the default for that key.
fn merge_and_clamp(scope: Scope, mut base: Value, overrides: &Value) -> Value {
    if let (Some(base_obj), Some(ov)) = (base.as_object_mut(), overrides.as_object()) {
        for (k, val) in ov {
            base_obj.insert(k.clone(), val.clone());
        }
    }
    clamp_for(scope, &mut base);
    base
}

// ---------------------------------------------------------------------------
// Store: raw JSONB persistence + TTL cache + typed resolve
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct CacheEntry {
    values: Value,
    at: Instant,
}

/// Cache key: system is a singleton; org/user key on their id.
#[derive(Clone, PartialEq, Eq, Hash)]
enum CacheKey {
    System,
    Org(Uuid),
    User(Uuid, Uuid),
}

/// Runtime-settings store. Cheap to clone (the cache is shared via `Arc` inside
/// [`crate::storage::Stores`]).
#[derive(Clone)]
pub struct SettingsStore {
    pool: PgPool,
    cache: std::sync::Arc<Mutex<HashMap<CacheKey, CacheEntry>>>,
}

impl SettingsStore {
    pub fn new(pool: PgPool) -> Self {
        Self {
            pool,
            cache: std::sync::Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn cache_get(&self, key: &CacheKey) -> Option<Value> {
        let map = self.cache.lock().ok()?;
        let entry = map.get(key)?;
        (entry.at.elapsed() < CACHE_TTL).then(|| entry.values.clone())
    }

    fn cache_put(&self, key: CacheKey, values: Value) {
        if let Ok(mut map) = self.cache.lock() {
            map.insert(
                key,
                CacheEntry {
                    values,
                    at: Instant::now(),
                },
            );
        }
    }

    fn cache_invalidate(&self, key: &CacheKey) {
        if let Ok(mut map) = self.cache.lock() {
            map.remove(key);
        }
    }

    // --- SYSTEM ------------------------------------------------------------

    /// Effective system settings (defaults ⊕ stored overrides, clamped).
    pub async fn resolve_system(&self) -> anyhow::Result<Value> {
        if let Some(v) = self.cache_get(&CacheKey::System) {
            return Ok(v);
        }
        let overrides = self.system_overrides().await?;
        let resolved = merge_and_clamp(Scope::System, system_defaults(), &overrides);
        self.cache_put(CacheKey::System, resolved.clone());
        Ok(resolved)
    }

    async fn system_overrides(&self) -> anyhow::Result<Value> {
        let row: Option<(Value,)> =
            sqlx::query_as("SELECT values FROM system_settings WHERE id = 1")
                .fetch_optional(&self.pool)
                .await
                .context("read system_settings")?;
        Ok(row.map(|r| r.0).unwrap_or_else(|| json!({})))
    }

    /// Merge a partial patch into the stored system overrides (top-level keys),
    /// persist, and invalidate the cache. Returns the new effective settings.
    pub async fn patch_system(
        &self,
        patch: &Value,
        updated_by: Option<Uuid>,
    ) -> anyhow::Result<Value> {
        let mut overrides = self.system_overrides().await?;
        apply_patch(&mut overrides, patch);
        sqlx::query(
            "INSERT INTO system_settings (id, values, updated_at, updated_by) \
             VALUES (1, $1, now(), $2) \
             ON CONFLICT (id) DO UPDATE SET values = $1, updated_at = now(), updated_by = $2",
        )
        .bind(&overrides)
        .bind(updated_by)
        .execute(&self.pool)
        .await
        .context("write system_settings")?;
        self.cache_invalidate(&CacheKey::System);
        self.resolve_system().await
    }

    // --- ORG ---------------------------------------------------------------

    /// Effective org settings for a tenant (defaults ⊕ stored overrides).
    pub async fn resolve_org(&self, tenant_id: Uuid) -> anyhow::Result<Value> {
        if let Some(v) = self.cache_get(&CacheKey::Org(tenant_id)) {
            return Ok(v);
        }
        let row = self.org_row(tenant_id).await?;
        let resolved = merge_and_clamp(Scope::Org, org_defaults(), &row.overrides);
        self.cache_put(CacheKey::Org(tenant_id), resolved.clone());
        Ok(resolved)
    }

    /// Workspace identity + effective settings, the shape the admin general page
    /// and `GET /api/org/settings` return.
    pub async fn org_bundle(&self, tenant_id: Uuid) -> anyhow::Result<OrgBundle> {
        let row = self.org_row(tenant_id).await?;
        let settings = merge_and_clamp(Scope::Org, org_defaults(), &row.overrides);
        let overridden = row
            .overrides
            .as_object()
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default();
        Ok(OrgBundle {
            name: row.name,
            logo_key: row.logo_key,
            settings,
            defaults: org_defaults(),
            overridden,
            updated_at: row.updated_at,
        })
    }

    async fn org_row(&self, tenant_id: Uuid) -> anyhow::Result<OrgRow> {
        #[derive(sqlx::FromRow)]
        struct Row {
            name: Option<String>,
            logo_key: Option<String>,
            values: Value,
            updated_at: chrono::DateTime<chrono::Utc>,
        }
        let mut tx = self.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;
        let row: Option<Row> = sqlx::query_as(
            "SELECT name, logo_key, values, updated_at FROM org_settings WHERE tenant_id = $1",
        )
        .bind(tenant_id)
        .fetch_optional(&mut *tx)
        .await
        .context("read org_settings")?;
        tx.commit().await?;
        Ok(match row {
            Some(r) => OrgRow {
                name: r.name,
                logo_key: r.logo_key,
                overrides: r.values,
                updated_at: Some(r.updated_at),
            },
            None => OrgRow {
                name: None,
                logo_key: None,
                overrides: json!({}),
                updated_at: None,
            },
        })
    }

    /// Merge a settings patch (and optionally name/logo) into a tenant's stored
    /// overrides, persist, invalidate cache, and return the new bundle.
    pub async fn patch_org(
        &self,
        tenant_id: Uuid,
        settings_patch: &Value,
        name: Option<String>,
        logo_key: Option<Option<String>>,
    ) -> anyhow::Result<OrgBundle> {
        let cur = self.org_row(tenant_id).await?;
        let mut overrides = cur.overrides;
        apply_patch(&mut overrides, settings_patch);
        let name = name.or(cur.name);
        // logo_key: Some(Some) sets, Some(None) clears, None leaves unchanged.
        let logo_key = match logo_key {
            Some(v) => v,
            None => cur.logo_key,
        };

        let mut tx = self.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;
        sqlx::query(
            "INSERT INTO org_settings (tenant_id, name, logo_key, values, updated_at) \
             VALUES ($1, $2, $3, $4, now()) \
             ON CONFLICT (tenant_id) DO UPDATE \
               SET name = $2, logo_key = $3, values = $4, updated_at = now()",
        )
        .bind(tenant_id)
        .bind(&name)
        .bind(&logo_key)
        .bind(&overrides)
        .execute(&mut *tx)
        .await
        .context("write org_settings")?;
        tx.commit().await?;

        self.cache_invalidate(&CacheKey::Org(tenant_id));
        let overridden = overrides
            .as_object()
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default();
        Ok(OrgBundle {
            name,
            logo_key,
            settings: merge_and_clamp(Scope::Org, org_defaults(), &overrides),
            defaults: org_defaults(),
            overridden,
            updated_at: Some(chrono::Utc::now()),
        })
    }

    // --- USER --------------------------------------------------------------

    /// Effective user preferences (defaults ⊕ stored overrides).
    pub async fn resolve_user(&self, tenant_id: Uuid, user_id: Uuid) -> anyhow::Result<Value> {
        if let Some(v) = self.cache_get(&CacheKey::User(tenant_id, user_id)) {
            return Ok(v);
        }
        let overrides = self.user_overrides(tenant_id, user_id).await?;
        let resolved = merge_and_clamp(Scope::User, user_defaults(), &overrides);
        self.cache_put(CacheKey::User(tenant_id, user_id), resolved.clone());
        Ok(resolved)
    }

    /// Raw stored preferences blob (NOT merged with defaults) — the shape
    /// `GET /api/preferences` returns as `{ prefs }`.
    pub async fn user_prefs_raw(&self, tenant_id: Uuid, user_id: Uuid) -> anyhow::Result<Value> {
        self.user_overrides(tenant_id, user_id).await
    }

    /// Replace the whole preferences blob (the `PATCH /api/preferences`
    /// contract sends the entire object). Invalidates the cache.
    pub async fn set_user_prefs_raw(
        &self,
        tenant_id: Uuid,
        user_id: Uuid,
        values: &Value,
    ) -> anyhow::Result<()> {
        let mut tx = self.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;
        sqlx::query(
            "INSERT INTO user_preferences (user_id, tenant_id, values, updated_at) \
             VALUES ($1, $2, $3, now()) \
             ON CONFLICT (user_id, tenant_id) DO UPDATE SET values = $3, updated_at = now()",
        )
        .bind(user_id)
        .bind(tenant_id)
        .bind(values)
        .execute(&mut *tx)
        .await
        .context("write user_preferences (raw)")?;
        tx.commit().await?;
        self.cache_invalidate(&CacheKey::User(tenant_id, user_id));
        Ok(())
    }

    async fn user_overrides(&self, tenant_id: Uuid, user_id: Uuid) -> anyhow::Result<Value> {
        let mut tx = self.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;
        let row: Option<(Value,)> = sqlx::query_as(
            "SELECT values FROM user_preferences WHERE tenant_id = $1 AND user_id = $2",
        )
        .bind(tenant_id)
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await
        .context("read user_preferences")?;
        tx.commit().await?;
        Ok(row.map(|r| r.0).unwrap_or_else(|| json!({})))
    }

    /// Merge a preferences patch, persist, invalidate, return effective prefs.
    pub async fn patch_user(
        &self,
        tenant_id: Uuid,
        user_id: Uuid,
        patch: &Value,
    ) -> anyhow::Result<Value> {
        let mut overrides = self.user_overrides(tenant_id, user_id).await?;
        apply_patch(&mut overrides, patch);
        let mut tx = self.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;
        sqlx::query(
            "INSERT INTO user_preferences (user_id, tenant_id, values, updated_at) \
             VALUES ($1, $2, $3, now()) \
             ON CONFLICT (user_id, tenant_id) DO UPDATE SET values = $3, updated_at = now()",
        )
        .bind(user_id)
        .bind(tenant_id)
        .bind(&overrides)
        .execute(&mut *tx)
        .await
        .context("write user_preferences")?;
        tx.commit().await?;
        self.cache_invalidate(&CacheKey::User(tenant_id, user_id));
        Ok(merge_and_clamp(Scope::User, user_defaults(), &overrides))
    }
}

/// Workspace identity + effective settings for a tenant — the full shape the
/// `/api/org/settings` endpoint serializes.
#[derive(Debug, Clone)]
pub struct OrgBundle {
    pub name: Option<String>,
    pub logo_key: Option<String>,
    /// Effective settings (defaults ⊕ stored overrides, clamped).
    pub settings: Value,
    /// Pure code/env defaults (what a cleared override falls back to).
    pub defaults: Value,
    /// Top-level keys that currently have a stored override.
    pub overridden: Vec<String>,
    pub updated_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// Internal: a raw `org_settings` row (or empty defaults when absent).
struct OrgRow {
    name: Option<String>,
    logo_key: Option<String>,
    overrides: Value,
    updated_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// Deep-merge `patch` into `target`: objects merge recursively, everything else
/// replaces. A `null` in the patch deletes the key (lets the admin UI clear an
/// override back to the code/env default).
fn apply_patch(target: &mut Value, patch: &Value) {
    let (Some(t), Some(p)) = (target.as_object_mut(), patch.as_object()) else {
        *target = patch.clone();
        return;
    };
    for (k, v) in p {
        if v.is_null() {
            t.remove(k);
        } else if v.is_object() && t.get(k).map(Value::is_object).unwrap_or(false) {
            apply_patch(t.get_mut(k).unwrap(), v);
        } else {
            t.insert(k.clone(), v.clone());
        }
    }
}

/// Read a numeric org setting as f64 from a resolved bundle, else its default.
pub fn org_f64(resolved: &Value, key: &str, default: f64) -> f64 {
    resolved.get(key).and_then(Value::as_f64).unwrap_or(default)
}
/// Read a numeric org setting as i64 from a resolved bundle, else its default.
pub fn org_i64(resolved: &Value, key: &str, default: i64) -> i64 {
    resolved.get(key).and_then(Value::as_i64).unwrap_or(default)
}
/// Read a bool org setting from a resolved bundle, else its default.
pub fn org_bool(resolved: &Value, key: &str, default: bool) -> bool {
    resolved
        .get(key)
        .and_then(Value::as_bool)
        .unwrap_or(default)
}
/// Read a nested i64 (e.g. `queue.concurrency`) from a resolved system bundle.
pub fn sys_nested_i64(resolved: &Value, parent: &str, key: &str, default: i64) -> i64 {
    resolved
        .get(parent)
        .and_then(|p| p.get(key))
        .and_then(Value::as_i64)
        .unwrap_or(default)
}

/// Discard unknown top-level keys from a client patch, keeping only keys that
/// exist in the scope's defaults (defense against arbitrary JSONB injection).
pub fn whitelist_patch(scope: Scope, patch: Value) -> Value {
    let allowed = defaults_for(scope);
    let (Some(allowed_obj), Some(patch_obj)) = (allowed.as_object(), patch.as_object()) else {
        return json!({});
    };
    let mut out = Map::new();
    for (k, v) in patch_obj {
        if allowed_obj.contains_key(k) {
            out.insert(k.clone(), v.clone());
        }
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn org_defaults_resolve_and_clamp() {
        let merged = merge_and_clamp(Scope::Org, org_defaults(), &json!({}));
        assert_eq!(merged["dedupCosine"].as_f64().unwrap(), 0.9);
        assert_eq!(merged["searchTopK"].as_i64().unwrap(), 20);
        assert!(merged["ai"]["fallbackOrder"].is_array());
    }

    #[test]
    fn override_wins_and_clamps() {
        // out-of-range override is clamped
        let merged = merge_and_clamp(Scope::Org, org_defaults(), &json!({ "searchTopK": 9999 }));
        assert_eq!(merged["searchTopK"].as_i64().unwrap(), 200);
        let merged = merge_and_clamp(Scope::Org, org_defaults(), &json!({ "dedupCosine": 2.0 }));
        assert_eq!(merged["dedupCosine"].as_f64().unwrap(), 1.0);
    }

    #[test]
    fn patch_null_deletes_and_objects_merge() {
        let mut base = json!({ "a": 1, "nested": { "x": 1, "y": 2 } });
        apply_patch(
            &mut base,
            &json!({ "a": null, "nested": { "y": 9, "z": 3 } }),
        );
        assert!(base.get("a").is_none());
        assert_eq!(base["nested"], json!({ "x": 1, "y": 9, "z": 3 }));
    }

    #[test]
    fn whitelist_drops_unknown_keys() {
        let out = whitelist_patch(Scope::Org, json!({ "searchTopK": 5, "evil": true }));
        assert!(out.get("searchTopK").is_some());
        assert!(out.get("evil").is_none());
    }

    #[test]
    fn system_clamps_nested() {
        let merged = merge_and_clamp(
            Scope::System,
            system_defaults(),
            &json!({ "queue": { "concurrency": 999 } }),
        );
        assert_eq!(merged["queue"]["concurrency"].as_i64().unwrap(), 64);
    }
}
