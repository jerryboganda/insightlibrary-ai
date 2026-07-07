//! LLM gateway (Phase 5): one [`LlmProvider`] trait over the paid cloud
//! providers (Anthropic / Gemini / OpenAI, BYO key from env). No local Ollama
//! on this RAM-tight VPS.
//!
//! Degradation contract: Phase 5 (embeddings, sparse, FTS, RRF, rerank) is
//! fully local and MUST work with NO paid key configured. Every LLM call site
//! therefore treats the LLM as optional: [`provider_from_env`] returns `None`
//! when no key is set, and [`contextual_prefix`] returns `Ok(None)` so callers
//! simply skip the contextual-prefix step. The LLM becomes required only in
//! later phases.

use anyhow::Context;
use serde_json::json;

/// The provider we selected and the model + key it will use. `Debug` is manual
/// so the API key never leaks through `{:?}`.
#[derive(Clone)]
pub struct LlmConfig {
    pub provider: ProviderKind,
    pub model: String,
    api_key: String,
}

impl std::fmt::Debug for LlmConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LlmConfig")
            .field("provider", &self.provider)
            .field("model", &self.model)
            .field("api_key", &"***")
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    Anthropic,
    Gemini,
    OpenAi,
}

/// Minimal completion interface. Native async-fn-in-trait (not dyn), matching
/// the storage traits in this crate.
#[allow(async_fn_in_trait)]
pub trait LlmProvider {
    /// Complete `user` under `system`, returning the assistant text.
    async fn complete(&self, system: &str, user: &str) -> anyhow::Result<String>;
}

/// Select a provider from the environment, preferring, in order,
/// `ANTHROPIC_API_KEY`, then `GEMINI_API_KEY`, then `OPENAI_API_KEY`. Returns
/// `None` when NONE is set (a non-empty value is required) — callers then skip
/// any LLM step. Model ids are overridable via `*_MODEL` env vars.
pub fn provider_from_env() -> Option<CloudProvider> {
    fn non_empty(key: &str) -> Option<String> {
        std::env::var(key).ok().filter(|v| !v.trim().is_empty())
    }
    fn model(key: &str, default: &str) -> String {
        non_empty(key).unwrap_or_else(|| default.to_string())
    }

    if let Some(api_key) = non_empty("ANTHROPIC_API_KEY") {
        return Some(CloudProvider::new(LlmConfig {
            provider: ProviderKind::Anthropic,
            model: model("ANTHROPIC_MODEL", "claude-3-5-haiku-latest"),
            api_key,
        }));
    }
    if let Some(api_key) = non_empty("GEMINI_API_KEY") {
        return Some(CloudProvider::new(LlmConfig {
            provider: ProviderKind::Gemini,
            model: model("GEMINI_MODEL", "gemini-1.5-flash"),
            api_key,
        }));
    }
    if let Some(api_key) = non_empty("OPENAI_API_KEY") {
        return Some(CloudProvider::new(LlmConfig {
            provider: ProviderKind::OpenAi,
            model: model("OPENAI_MODEL", "gpt-4o-mini"),
            api_key,
        }));
    }
    None
}

/// Concrete cloud provider over a shared reqwest client. One type dispatches to
/// the three wire protocols by [`ProviderKind`] so callers stay simple.
#[derive(Clone)]
pub struct CloudProvider {
    cfg: LlmConfig,
    http: reqwest::Client,
}

impl CloudProvider {
    fn new(cfg: LlmConfig) -> Self {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .unwrap_or_default();
        Self { cfg, http }
    }

    async fn complete_anthropic(&self, system: &str, user: &str) -> anyhow::Result<String> {
        let body = json!({
            "model": self.cfg.model,
            "max_tokens": 256,
            "system": system,
            "messages": [{ "role": "user", "content": user }],
        });
        let resp = self
            .http
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &self.cfg.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await
            .context("anthropic request")?;
        let value = json_or_status(resp).await?;
        value["content"][0]["text"]
            .as_str()
            .map(str::to_string)
            .context("anthropic response missing content[0].text")
    }

    async fn complete_gemini(&self, system: &str, user: &str) -> anyhow::Result<String> {
        // Gemini generateContent; system goes in system_instruction. The key is
        // a query param on this endpoint.
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            self.cfg.model, self.cfg.api_key
        );
        let body = json!({
            "system_instruction": { "parts": [{ "text": system }] },
            "contents": [{ "role": "user", "parts": [{ "text": user }] }],
            "generationConfig": { "maxOutputTokens": 256 },
        });
        let resp = self
            .http
            .post(&url)
            .json(&body)
            .send()
            .await
            .context("gemini request")?;
        let value = json_or_status(resp).await?;
        value["candidates"][0]["content"]["parts"][0]["text"]
            .as_str()
            .map(str::to_string)
            .context("gemini response missing candidates[0].content.parts[0].text")
    }

    async fn complete_openai(&self, system: &str, user: &str) -> anyhow::Result<String> {
        let body = json!({
            "model": self.cfg.model,
            "max_tokens": 256,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user },
            ],
        });
        let resp = self
            .http
            .post("https://api.openai.com/v1/chat/completions")
            .bearer_auth(&self.cfg.api_key)
            .json(&body)
            .send()
            .await
            .context("openai request")?;
        let value = json_or_status(resp).await?;
        value["choices"][0]["message"]["content"]
            .as_str()
            .map(str::to_string)
            .context("openai response missing choices[0].message.content")
    }
}

impl LlmProvider for CloudProvider {
    async fn complete(&self, system: &str, user: &str) -> anyhow::Result<String> {
        match self.cfg.provider {
            ProviderKind::Anthropic => self.complete_anthropic(system, user).await,
            ProviderKind::Gemini => self.complete_gemini(system, user).await,
            ProviderKind::OpenAi => self.complete_openai(system, user).await,
        }
    }
}

/// Read the JSON body, mapping a non-2xx status to a clear error WITHOUT
/// echoing the response verbatim (a provider error body can embed the key or
/// prompt). Only the status code is surfaced.
async fn json_or_status(resp: reqwest::Response) -> anyhow::Result<serde_json::Value> {
    let status = resp.status();
    if !status.is_success() {
        anyhow::bail!("llm provider returned HTTP {status}");
    }
    resp.json().await.context("decoding llm provider response")
}

/// Generate a one-sentence contextual prefix (<=25 words) situating `chunk_text`
/// within a document titled `doc_title`. Returns:
///   * `Ok(None)`   when no LLM key is configured (Phase 5 skips the step), and
///   * `Ok(Some(_))` with the trimmed, single-line prefix on success.
///
/// The prompt is deliberately tiny (cost + latency); the result is truncated to
/// one line so a chatty model can't inject newlines into the stored prefix.
pub async fn contextual_prefix(
    doc_title: &str,
    chunk_text: &str,
) -> anyhow::Result<Option<String>> {
    let Some(provider) = provider_from_env() else {
        return Ok(None);
    };
    let system = "You situate a text chunk within its document. Reply with ONE short sentence \
                  (at most 25 words) that gives retrieval context for the chunk. No preamble, \
                  no quotes, no markdown.";
    // Cap the chunk we send so a huge block can't blow the prompt budget.
    let excerpt: String = chunk_text.chars().take(1200).collect();
    let user = format!("Document title: {doc_title}\n\nChunk:\n{excerpt}");
    let raw = provider.complete(system, &user).await?;
    let prefix = raw
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .trim()
        .to_string();
    Ok((!prefix.is_empty()).then_some(prefix))
}
