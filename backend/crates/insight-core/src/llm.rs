//! LLM gateway (Phase 8): multi-provider completion with per-task routing +
//! fallback, BYO keys (envelope-encrypted at rest), pricing/metering into
//! `usage_records`, and a monthly-budget gate.
//!
//! Seven provider ids over three wire dialects:
//!   * **Gemini** native (`generateContent`),
//!   * **Anthropic** native (`/v1/messages`),
//!   * **OpenAI-compatible** (`/v1/chat/completions`) for openai, moonshot,
//!     deepseek, minimax, and a generic `openai_compatible` (base URL from
//!     org settings).
//!
//! Key resolution is user-scope → org-scope (both from `user_provider_keys`,
//! decrypted with the `PROVIDER_KEY_KEK`) → the provider's env var. A provider
//! with no resolvable key is skipped in the routing chain.
//!
//! Degradation contract (from Phase 5) is preserved: with NO key anywhere,
//! [`contextual_prefix`] returns `Ok(None)` and callers skip the LLM step.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use anyhow::Context;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::settings;
use crate::storage::{set_tenant, Stores};

// ---------------------------------------------------------------------------
// Providers, tasks, dialects
// ---------------------------------------------------------------------------

/// A supported LLM provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderId {
    Gemini,
    Anthropic,
    OpenAi,
    Moonshot,
    DeepSeek,
    MiniMax,
    OpenAiCompatible,
}

/// The five OpenAI-compatible providers plus the two natives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Dialect {
    Gemini,
    Anthropic,
    OpenAiCompatible,
}

impl ProviderId {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderId::Gemini => "gemini",
            ProviderId::Anthropic => "anthropic",
            ProviderId::OpenAi => "openai",
            ProviderId::Moonshot => "moonshot",
            ProviderId::DeepSeek => "deepseek",
            ProviderId::MiniMax => "minimax",
            ProviderId::OpenAiCompatible => "openai_compatible",
        }
    }

    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Option<Self> {
        Some(match s.trim().to_ascii_lowercase().as_str() {
            "gemini" | "google" => ProviderId::Gemini,
            "anthropic" | "claude" => ProviderId::Anthropic,
            "openai" => ProviderId::OpenAi,
            "moonshot" | "kimi" => ProviderId::Moonshot,
            "deepseek" => ProviderId::DeepSeek,
            "minimax" => ProviderId::MiniMax,
            "openai_compatible" | "openai-compatible" | "compat" => ProviderId::OpenAiCompatible,
            _ => return None,
        })
    }

    /// All providers (for the AI settings page registry).
    pub fn all() -> [ProviderId; 7] {
        [
            ProviderId::Gemini,
            ProviderId::Anthropic,
            ProviderId::OpenAi,
            ProviderId::Moonshot,
            ProviderId::DeepSeek,
            ProviderId::MiniMax,
            ProviderId::OpenAiCompatible,
        ]
    }

    fn dialect(self) -> Dialect {
        match self {
            ProviderId::Gemini => Dialect::Gemini,
            ProviderId::Anthropic => Dialect::Anthropic,
            _ => Dialect::OpenAiCompatible,
        }
    }

    /// Env var holding this provider's server key.
    fn env_key(self) -> &'static str {
        match self {
            ProviderId::Gemini => "GEMINI_API_KEY",
            ProviderId::Anthropic => "ANTHROPIC_API_KEY",
            ProviderId::OpenAi => "OPENAI_API_KEY",
            ProviderId::Moonshot => "MOONSHOT_API_KEY",
            ProviderId::DeepSeek => "DEEPSEEK_API_KEY",
            ProviderId::MiniMax => "MINIMAX_API_KEY",
            ProviderId::OpenAiCompatible => "OPENAI_COMPAT_API_KEY",
        }
    }

    /// Default OpenAI-compatible base URL (natives return their own endpoints
    /// and ignore this).
    fn default_base_url(self) -> &'static str {
        match self {
            ProviderId::OpenAi => "https://api.openai.com/v1",
            ProviderId::Moonshot => "https://api.moonshot.cn/v1",
            ProviderId::DeepSeek => "https://api.deepseek.com/v1",
            ProviderId::MiniMax => "https://api.minimax.chat/v1",
            _ => "",
        }
    }
}

/// A task class, mapped to a provider by org settings `ai.taskRouting`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Task {
    Chat,
    Extraction,
    Synthesis,
    Nli,
    Rerank,
    Embedding,
}

impl Task {
    fn key(self) -> &'static str {
        match self {
            Task::Chat => "chat",
            Task::Extraction => "extraction",
            Task::Synthesis => "synthesis",
            Task::Nli => "nli",
            Task::Rerank => "rerank",
            Task::Embedding => "embedding",
        }
    }
}

// ---------------------------------------------------------------------------
// BYO key encryption (AES-256-GCM, KEK from PROVIDER_KEY_KEK)
// ---------------------------------------------------------------------------

/// Parse the 32-byte key-encryption key from `PROVIDER_KEY_KEK` (hex or
/// base64). `None` when unset/invalid — BYO key storage is then unavailable
/// (env keys still work).
fn kek() -> Option<[u8; 32]> {
    let raw = std::env::var("PROVIDER_KEY_KEK").ok()?;
    let raw = raw.trim();
    // hex (64 chars)
    if raw.len() == 64 {
        if let Ok(bytes) = (0..32)
            .map(|i| u8::from_str_radix(&raw[i * 2..i * 2 + 2], 16))
            .collect::<Result<Vec<u8>, _>>()
        {
            let mut out = [0u8; 32];
            out.copy_from_slice(&bytes);
            return Some(out);
        }
    }
    // base64
    use base64::Engine;
    if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(raw) {
        if bytes.len() == 32 {
            let mut out = [0u8; 32];
            out.copy_from_slice(&bytes);
            return Some(out);
        }
    }
    None
}

/// Encrypt a plaintext key → `nonce(12) || ciphertext`.
pub fn encrypt_secret(plaintext: &str) -> anyhow::Result<Vec<u8>> {
    let kek = kek().context("PROVIDER_KEY_KEK not configured (cannot store BYO keys)")?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&kek));
    use argon2::password_hash::rand_core::{OsRng, RngCore};
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|_| anyhow::anyhow!("aes-gcm encrypt failed"))?;
    let mut out = Vec::with_capacity(12 + ciphertext.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Decrypt a `nonce(12) || ciphertext` blob.
fn decrypt_secret(blob: &[u8]) -> anyhow::Result<String> {
    anyhow::ensure!(blob.len() > 12, "ciphertext too short");
    let kek = kek().context("PROVIDER_KEY_KEK not configured")?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&kek));
    let nonce = Nonce::from_slice(&blob[..12]);
    let plaintext = cipher
        .decrypt(nonce, &blob[12..])
        .map_err(|_| anyhow::anyhow!("aes-gcm decrypt failed (wrong KEK?)"))?;
    String::from_utf8(plaintext).context("decrypted key is not utf-8")
}

/// All provider ids the key store accepts: the 7 chat providers plus the
/// non-chat vendor keys (rerank/parse). Matches the frontend `providerIdSchema`.
pub const KNOWN_PROVIDERS: &[&str] = &[
    "gemini",
    "anthropic",
    "openai",
    "moonshot",
    "deepseek",
    "minimax",
    "openai-compatible",
    "cohere",
    "jina",
    "llamaparse",
];

/// `true` when the string is a provider the key store accepts.
pub fn known_provider(provider: &str) -> bool {
    KNOWN_PROVIDERS.contains(&provider)
}

/// A provider's env var, whether chat or vendor.
fn env_var_for(provider: &str) -> &'static str {
    match provider {
        "gemini" => "GEMINI_API_KEY",
        "anthropic" => "ANTHROPIC_API_KEY",
        "openai" => "OPENAI_API_KEY",
        "moonshot" => "MOONSHOT_API_KEY",
        "deepseek" => "DEEPSEEK_API_KEY",
        "minimax" => "MINIMAX_API_KEY",
        "openai-compatible" => "OPENAI_COMPAT_API_KEY",
        "cohere" => "COHERE_API_KEY",
        "jina" => "JINA_API_KEY",
        "llamaparse" => "LLAMAPARSE_API_KEY",
        _ => "",
    }
}

/// `true` when a non-empty server env key exists for this provider.
pub fn env_configured(provider: &str) -> bool {
    let var = env_var_for(provider);
    !var.is_empty()
        && std::env::var(var)
            .ok()
            .filter(|v| !v.trim().is_empty())
            .is_some()
}

/// `true` when BYO key storage is possible (KEK configured).
pub fn encryption_available() -> bool {
    kek().is_some()
}

/// Human label for a provider (AI settings registry).
pub fn provider_label(provider: &str) -> &'static str {
    match provider {
        "gemini" => "Google Gemini",
        "anthropic" => "Anthropic Claude",
        "openai" => "OpenAI",
        "moonshot" => "Moonshot (Kimi)",
        "deepseek" => "DeepSeek",
        "minimax" => "MiniMax",
        "openai-compatible" => "OpenAI-compatible",
        "cohere" => "Cohere (rerank)",
        "jina" => "Jina (rerank)",
        "llamaparse" => "LlamaParse",
        _ => "Unknown",
    }
}

/// `chat` = routable LLM; `vendor` = service key (rerank/parse).
pub fn provider_kind(provider: &str) -> &'static str {
    match provider {
        "cohere" | "jina" | "llamaparse" => "vendor",
        _ => "chat",
    }
}

/// Providers that can produce embeddings.
pub fn provider_supports_embeddings(provider: &str) -> bool {
    matches!(provider, "gemini" | "openai")
}

/// Store (upsert) a BYO key for a provider string at org or user scope.
pub async fn store_provider_key(
    stores: &Stores,
    tenant_id: Uuid,
    user_id: Uuid,
    provider: &str,
    scope: &str,
    plaintext: &str,
) -> anyhow::Result<()> {
    let ciphertext = encrypt_secret(plaintext)?;
    let hint: String = plaintext
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let (scope, user_key) = if scope == "user" {
        ("user", Some(user_id))
    } else {
        ("org", None)
    };

    let mut tx = stores.pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    sqlx::query(
        "DELETE FROM user_provider_keys \
         WHERE provider = $1 AND scope = $2 \
           AND (($2 = 'org') OR ($2 = 'user' AND user_id = $3))",
    )
    .bind(provider)
    .bind(scope)
    .bind(user_key)
    .execute(&mut *tx)
    .await
    .context("clear existing provider key")?;
    sqlx::query(
        "INSERT INTO user_provider_keys (tenant_id, provider, ciphertext, user_id, scope, key_hint) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(tenant_id)
    .bind(provider)
    .bind(&ciphertext)
    .bind(user_key)
    .bind(scope)
    .bind(&hint)
    .execute(&mut *tx)
    .await
    .context("insert provider key")?;
    tx.commit().await?;
    Ok(())
}

/// Delete a BYO key for a provider string / scope.
pub async fn delete_provider_key(
    stores: &Stores,
    tenant_id: Uuid,
    user_id: Uuid,
    provider: &str,
    scope: &str,
) -> anyhow::Result<()> {
    let (scope, user_key) = if scope == "user" {
        ("user", Some(user_id))
    } else {
        ("org", None)
    };
    let mut tx = stores.pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    sqlx::query(
        "DELETE FROM user_provider_keys \
         WHERE provider = $1 AND scope = $2 \
           AND (($2 = 'org') OR ($2 = 'user' AND user_id = $3))",
    )
    .bind(provider)
    .bind(scope)
    .bind(user_key)
    .execute(&mut *tx)
    .await
    .context("delete provider key")?;
    tx.commit().await?;
    Ok(())
}

/// Non-secret summary of a stored key (for the AI settings page).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ProviderKeyInfo {
    pub provider: String,
    pub scope: String,
    pub key_hint: Option<String>,
    pub user_id: Option<Uuid>,
}

/// List a tenant's stored BYO keys (metadata only, never the secret).
pub async fn list_provider_keys(
    stores: &Stores,
    tenant_id: Uuid,
) -> anyhow::Result<Vec<ProviderKeyInfo>> {
    let mut tx = stores.pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    let rows: Vec<ProviderKeyInfo> = sqlx::query_as(
        "SELECT provider, scope, key_hint, user_id FROM user_provider_keys ORDER BY provider, scope",
    )
    .fetch_all(&mut *tx)
    .await
    .context("list provider keys")?;
    tx.commit().await?;
    Ok(rows)
}

/// Resolve an API key for `provider`: user-scope BYO → org-scope BYO → env.
async fn resolve_api_key(
    stores: &Stores,
    tenant_id: Uuid,
    user_id: Option<Uuid>,
    provider: ProviderId,
) -> anyhow::Result<Option<String>> {
    let mut tx = stores.pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    // Prefer a user-scope key, then org-scope.
    let row: Option<(Vec<u8>,)> = sqlx::query_as(
        "SELECT ciphertext FROM user_provider_keys \
         WHERE provider = $1 \
           AND ((scope = 'user' AND user_id = $2) OR scope = 'org') \
         ORDER BY (scope = 'user') DESC LIMIT 1",
    )
    .bind(provider.as_str())
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await
    .context("resolve provider key")?;
    tx.commit().await?;

    if let Some((blob,)) = row {
        return Ok(Some(decrypt_secret(&blob)?));
    }
    // Env fallback.
    Ok(std::env::var(provider.env_key())
        .ok()
        .filter(|v| !v.trim().is_empty()))
}

// ---------------------------------------------------------------------------
// Pricing + metering
// ---------------------------------------------------------------------------

/// Default price table: (model substring, in $/1M, out $/1M). First match wins.
/// Overridable via `system_settings.pricing.models`.
const DEFAULT_PRICES: &[(&str, f64, f64)] = &[
    ("gemini-2.5-pro", 1.25, 10.0),
    ("gemini-2.5-flash", 0.15, 0.60),
    ("gemini-1.5-pro", 1.25, 5.0),
    ("gemini-1.5-flash", 0.075, 0.30),
    ("gemini", 0.15, 0.60),
    ("claude-sonnet", 3.0, 15.0),
    ("claude-3-5-haiku", 0.80, 4.0),
    ("claude-3-haiku", 0.25, 1.25),
    ("claude", 3.0, 15.0),
    ("gpt-4o-mini", 0.15, 0.60),
    ("gpt-4o", 2.50, 10.0),
    ("gpt-4", 10.0, 30.0),
    ("deepseek", 0.27, 1.10),
    ("kimi", 0.60, 2.50),
    ("moonshot", 0.60, 2.50),
    ("minimax", 0.20, 1.10),
];

fn price_for(model: &str, pricing_override: &Value) -> (f64, f64) {
    let m = model.to_ascii_lowercase();
    // System-settings override table first.
    if let Some(models) = pricing_override.get("models").and_then(Value::as_array) {
        for entry in models {
            if let Some(pat) = entry.get("match").and_then(Value::as_str) {
                if m.contains(&pat.to_ascii_lowercase()) {
                    let i = entry.get("in").and_then(Value::as_f64).unwrap_or(1.0);
                    let o = entry.get("out").and_then(Value::as_f64).unwrap_or(3.0);
                    return (i, o);
                }
            }
        }
    }
    for (pat, i, o) in DEFAULT_PRICES {
        if m.contains(pat) {
            return (*i, *o);
        }
    }
    (1.0, 3.0)
}

/// A completed call, with token accounting for metering.
#[derive(Debug, Clone)]
pub struct Completion {
    pub text: String,
    pub in_tokens: i64,
    pub out_tokens: i64,
    pub estimated: bool,
}

fn est_tokens(s: &str) -> i64 {
    (s.chars().count() as i64 / 4).max(1)
}

// ---------------------------------------------------------------------------
// Resolved provider + wire calls
// ---------------------------------------------------------------------------

/// A provider resolved for a specific call: id + model + key + base URL.
#[derive(Clone)]
pub struct ResolvedProvider {
    pub id: ProviderId,
    pub model: String,
    api_key: String,
    base_url: String,
    http: reqwest::Client,
}

impl std::fmt::Debug for ResolvedProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResolvedProvider")
            .field("id", &self.id)
            .field("model", &self.model)
            .field("api_key", &"***")
            .finish()
    }
}

impl ResolvedProvider {
    fn new(id: ProviderId, model: String, api_key: String, base_url: String) -> Self {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(90))
            .build()
            .unwrap_or_default();
        Self {
            id,
            model,
            api_key,
            base_url,
            http,
        }
    }

    /// Complete `user` under `system`, with token accounting.
    pub async fn complete(&self, system: &str, user: &str) -> anyhow::Result<Completion> {
        match self.id.dialect() {
            Dialect::Anthropic => self.complete_anthropic(system, user).await,
            Dialect::Gemini => self.complete_gemini(system, user).await,
            Dialect::OpenAiCompatible => self.complete_openai(system, user).await,
        }
    }

    async fn complete_anthropic(&self, system: &str, user: &str) -> anyhow::Result<Completion> {
        let body = json!({
            "model": self.model,
            "max_tokens": 1024,
            "system": system,
            "messages": [{ "role": "user", "content": user }],
        });
        let resp = self
            .http
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await
            .context("anthropic request")?;
        let v = json_or_status(resp).await?;
        let text = v["content"][0]["text"]
            .as_str()
            .context("anthropic missing content[0].text")?
            .to_string();
        let (in_t, out_t, est) = match (
            v["usage"]["input_tokens"].as_i64(),
            v["usage"]["output_tokens"].as_i64(),
        ) {
            (Some(i), Some(o)) => (i, o, false),
            _ => (
                est_tokens(&format!("{system}{user}")),
                est_tokens(&text),
                true,
            ),
        };
        Ok(Completion {
            text,
            in_tokens: in_t,
            out_tokens: out_t,
            estimated: est,
        })
    }

    async fn complete_gemini(&self, system: &str, user: &str) -> anyhow::Result<Completion> {
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            self.model, self.api_key
        );
        let body = json!({
            "system_instruction": { "parts": [{ "text": system }] },
            "contents": [{ "role": "user", "parts": [{ "text": user }] }],
            "generationConfig": { "maxOutputTokens": 1024 },
        });
        let resp = self
            .http
            .post(&url)
            .json(&body)
            .send()
            .await
            .context("gemini request")?;
        let v = json_or_status(resp).await?;
        let text = v["candidates"][0]["content"]["parts"][0]["text"]
            .as_str()
            .context("gemini missing candidates[0].content.parts[0].text")?
            .to_string();
        let (in_t, out_t, est) = match (
            v["usageMetadata"]["promptTokenCount"].as_i64(),
            v["usageMetadata"]["candidatesTokenCount"].as_i64(),
        ) {
            (Some(i), Some(o)) => (i, o, false),
            _ => (
                est_tokens(&format!("{system}{user}")),
                est_tokens(&text),
                true,
            ),
        };
        Ok(Completion {
            text,
            in_tokens: in_t,
            out_tokens: out_t,
            estimated: est,
        })
    }

    async fn complete_openai(&self, system: &str, user: &str) -> anyhow::Result<Completion> {
        let base = if self.base_url.is_empty() {
            self.id.default_base_url().to_string()
        } else {
            self.base_url.trim_end_matches('/').to_string()
        };
        anyhow::ensure!(!base.is_empty(), "no base url for {}", self.id.as_str());
        let body = json!({
            "model": self.model,
            "max_tokens": 1024,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user },
            ],
        });
        let resp = self
            .http
            .post(format!("{base}/chat/completions"))
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .context("openai-compatible request")?;
        let v = json_or_status(resp).await?;
        let text = v["choices"][0]["message"]["content"]
            .as_str()
            .context("openai-compatible missing choices[0].message.content")?
            .to_string();
        let (in_t, out_t, est) = match (
            v["usage"]["prompt_tokens"].as_i64(),
            v["usage"]["completion_tokens"].as_i64(),
        ) {
            (Some(i), Some(o)) => (i, o, false),
            _ => (
                est_tokens(&format!("{system}{user}")),
                est_tokens(&text),
                true,
            ),
        };
        Ok(Completion {
            text,
            in_tokens: in_t,
            out_tokens: out_t,
            estimated: est,
        })
    }
}

/// Read the JSON body, mapping non-2xx to a clear error WITHOUT echoing the
/// body (a provider error can embed the key or prompt).
async fn json_or_status(resp: reqwest::Response) -> anyhow::Result<Value> {
    let status = resp.status();
    if !status.is_success() {
        anyhow::bail!("llm provider returned HTTP {status}");
    }
    resp.json().await.context("decoding llm provider response")
}

// ---------------------------------------------------------------------------
// Routing + metered completion
// ---------------------------------------------------------------------------

/// Build the ordered provider chain for a task: the task's routed provider
/// first, then the fallback order, de-duplicated, each resolved with a key.
async fn provider_chain(
    stores: &Stores,
    tenant_id: Uuid,
    user_id: Option<Uuid>,
    task: Task,
) -> anyhow::Result<Vec<ResolvedProvider>> {
    let cfg = stores.settings.resolve_org(tenant_id).await?;
    let ai = &cfg["ai"];

    let mut order: Vec<ProviderId> = Vec::new();
    if let Some(primary) = ai["taskRouting"][task.key()]
        .as_str()
        .and_then(ProviderId::from_str)
    {
        order.push(primary);
    }
    if let Some(fallback) = ai["fallbackOrder"].as_array() {
        for p in fallback
            .iter()
            .filter_map(Value::as_str)
            .filter_map(ProviderId::from_str)
        {
            if !order.contains(&p) {
                order.push(p);
            }
        }
    }
    // Ensure the natives are always reachable as a last resort.
    for p in [
        ProviderId::Gemini,
        ProviderId::Anthropic,
        ProviderId::OpenAi,
    ] {
        if !order.contains(&p) {
            order.push(p);
        }
    }

    let mut chain = Vec::new();
    for id in order {
        let Some(api_key) = resolve_api_key(stores, tenant_id, user_id, id).await? else {
            continue;
        };
        let model = ai["models"][id.as_str()]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| default_model(id))
            .to_string();
        let base_url = if id == ProviderId::OpenAiCompatible {
            ai["baseUrls"]["openaiCompatible"]
                .as_str()
                .unwrap_or("")
                .to_string()
        } else {
            String::new()
        };
        chain.push(ResolvedProvider::new(id, model, api_key, base_url));
    }
    Ok(chain)
}

fn default_model(id: ProviderId) -> &'static str {
    match id {
        ProviderId::Gemini => "gemini-2.5-flash",
        ProviderId::Anthropic => "claude-sonnet-5",
        ProviderId::OpenAi => "gpt-4o",
        ProviderId::Moonshot => "kimi-k2-0711-preview",
        ProviderId::DeepSeek => "deepseek-chat",
        ProviderId::MiniMax => "MiniMax-Text-01",
        ProviderId::OpenAiCompatible => "gpt-4o",
    }
}

/// Complete a task with routing + fallback, and meter the successful call.
/// `user_id` scopes BYO-key resolution and metering attribution.
pub async fn complete_metered(
    stores: &Stores,
    tenant_id: Uuid,
    user_id: Option<Uuid>,
    task: Task,
    system: &str,
    user: &str,
) -> anyhow::Result<Completion> {
    let chain = provider_chain(stores, tenant_id, user_id, task).await?;
    anyhow::ensure!(!chain.is_empty(), "no LLM provider is configured");

    let mut last_err: Option<anyhow::Error> = None;
    for provider in chain {
        match provider.complete(system, user).await {
            Ok(completion) => {
                if let Err(e) = meter(stores, tenant_id, &provider, task, &completion).await {
                    tracing::warn!(error = format!("{e:#}"), "metering write failed");
                }
                return Ok(completion);
            }
            Err(e) => {
                tracing::warn!(
                    provider = provider.id.as_str(),
                    error = format!("{e:#}"),
                    "provider failed; trying next"
                );
                last_err = Some(e);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("all providers failed")))
}

/// Write a `usage_records` row for a completed call (cost in micro-USD).
async fn meter(
    stores: &Stores,
    tenant_id: Uuid,
    provider: &ResolvedProvider,
    task: Task,
    c: &Completion,
) -> anyhow::Result<()> {
    let sys = stores.settings.resolve_system().await.unwrap_or_default();
    let (in_price, out_price) = price_for(&provider.model, &sys["pricing"]);
    let cost = (c.in_tokens as f64 / 1e6) * in_price + (c.out_tokens as f64 / 1e6) * out_price;
    let cost_micro = (cost * 1e6).round() as i64;
    let meta = json!({
        "provider": provider.id.as_str(),
        "model": provider.model,
        "task": task.key(),
        "inTokens": c.in_tokens,
        "outTokens": c.out_tokens,
        "estimated": c.estimated,
    });
    let mut tx = stores.pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    sqlx::query(
        "INSERT INTO usage_records (tenant_id, metric, quantity, meta) VALUES ($1, 'llm', $2, $3)",
    )
    .bind(tenant_id)
    .bind(cost_micro)
    .bind(&meta)
    .execute(&mut *tx)
    .await
    .context("insert usage record")?;
    tx.commit().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/// Month-to-date LLM spend in USD for a tenant.
pub async fn month_to_date_usd(stores: &Stores, tenant_id: Uuid) -> anyhow::Result<f64> {
    let mut tx = stores.pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    let row: (Option<i64>,) = sqlx::query_as(
        "SELECT COALESCE(SUM(quantity), 0)::bigint FROM usage_records \
         WHERE metric = 'llm' AND ts >= date_trunc('month', now())",
    )
    .fetch_one(&mut *tx)
    .await
    .context("sum month-to-date usage")?;
    tx.commit().await?;
    Ok(row.0.unwrap_or(0) as f64 / 1e6)
}

/// Budget check result — whether an interactive call may proceed.
pub struct BudgetStatus {
    pub spent_usd: f64,
    pub limit_usd: f64,
    pub over_limit: bool,
    pub over_soft: bool,
}

/// Evaluate the monthly budget for a tenant (limit 0 = unlimited).
pub async fn budget_status(stores: &Stores, tenant_id: Uuid) -> anyhow::Result<BudgetStatus> {
    let cfg = stores.settings.resolve_org(tenant_id).await?;
    let limit = settings::org_f64(&cfg, "budgetMonthlyLimitUsd", 0.0);
    let soft_pct = settings::org_i64(&cfg, "budgetSoftThresholdPct", 80) as f64;
    let spent = month_to_date_usd(stores, tenant_id).await?;
    let over_limit = limit > 0.0 && spent >= limit;
    let over_soft = limit > 0.0 && spent >= limit * soft_pct / 100.0;
    Ok(BudgetStatus {
        spent_usd: spent,
        limit_usd: limit,
        over_limit,
        over_soft,
    })
}

// ---------------------------------------------------------------------------
// Backward-compatible helpers (ingest)
// ---------------------------------------------------------------------------

/// `true` when at least one provider has a resolvable key for this tenant.
pub async fn provider_available(stores: &Stores, tenant_id: Uuid) -> bool {
    for id in ProviderId::all() {
        if let Ok(Some(_)) = resolve_api_key(stores, tenant_id, None, id).await {
            return true;
        }
    }
    false
}

/// Generate a one-sentence contextual prefix (<=25 words) situating
/// `chunk_text` within `doc_title`. Tenant-aware: routes via the extraction
/// task, using BYO/env keys, and meters. Returns `Ok(None)` when no provider is
/// configured (callers skip the step).
pub async fn contextual_prefix(
    stores: &Stores,
    tenant_id: Uuid,
    doc_title: &str,
    chunk_text: &str,
) -> anyhow::Result<Option<String>> {
    let system = "You situate a text chunk within its document. Reply with ONE short sentence \
                  (at most 25 words) that gives retrieval context for the chunk. No preamble, \
                  no quotes, no markdown.";
    let excerpt: String = chunk_text.chars().take(1200).collect();
    let user = format!("Document title: {doc_title}\n\nChunk:\n{excerpt}");
    let completion =
        match complete_metered(stores, tenant_id, None, Task::Extraction, system, &user).await {
            Ok(c) => c,
            // No provider configured is the expected degradation, not an error.
            Err(_) => return Ok(None),
        };
    let prefix = completion
        .text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .trim()
        .to_string();
    Ok((!prefix.is_empty()).then_some(prefix))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_id_roundtrip() {
        for id in ProviderId::all() {
            assert_eq!(ProviderId::from_str(id.as_str()), Some(id));
        }
        assert_eq!(ProviderId::from_str("kimi"), Some(ProviderId::Moonshot));
        assert_eq!(ProviderId::from_str("claude"), Some(ProviderId::Anthropic));
        assert_eq!(ProviderId::from_str("nope"), None);
    }

    #[test]
    fn pricing_matches_and_falls_back() {
        let (i, o) = price_for("gpt-4o-mini", &json!({}));
        assert_eq!((i, o), (0.15, 0.60));
        let (i, o) = price_for("some-unknown-model", &json!({}));
        assert_eq!((i, o), (1.0, 3.0));
        // Override wins.
        let ov = json!({ "models": [{ "match": "unknown", "in": 5.0, "out": 9.0 }] });
        assert_eq!(price_for("some-unknown-model", &ov), (5.0, 9.0));
    }

    #[test]
    fn encrypt_roundtrip_when_kek_set() {
        // 32-byte hex KEK.
        std::env::set_var(
            "PROVIDER_KEY_KEK",
            "0000000000000000000000000000000000000000000000000000000000000001",
        );
        let blob = encrypt_secret("sk-secret-value").unwrap();
        assert_ne!(&blob, b"sk-secret-value");
        assert_eq!(decrypt_secret(&blob).unwrap(), "sk-secret-value");
        std::env::remove_var("PROVIDER_KEY_KEK");
    }
}
