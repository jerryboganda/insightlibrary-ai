//! Shared application state + API configuration (from env).

use std::sync::Arc;

use anyhow::Context;
use insight_core::storage::{JobQueue, Stores};

/// API-layer configuration. `Debug` is manual so the JWT secret can never
/// leak through `{:?}`.
#[derive(Clone)]
pub struct ApiConfig {
    pub jwt_secret: String,
    pub access_ttl_secs: u64,
    pub refresh_ttl_secs: u64,
    pub cors_origins: Vec<String>,
    pub rate_limit_max: u64,
    pub rate_limit_window_secs: u64,
    /// IP-keyed cap for the anonymous auth endpoints (sign-in/sign-up/
    /// refresh): every attempt burns an argon2id verify (~19 MiB, t=2), so
    /// these must be throttled BEFORE any credentials are checked.
    pub auth_rate_limit_max: u64,
    /// `Secure` attribute on auth cookies. Defaults to true (production is
    /// behind the Cloudflare tunnel); set COOKIE_SECURE=false for plain-http
    /// local stacks.
    pub cookie_secure: bool,
}

impl std::fmt::Debug for ApiConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApiConfig")
            .field("jwt_secret", &"***")
            .field("access_ttl_secs", &self.access_ttl_secs)
            .field("refresh_ttl_secs", &self.refresh_ttl_secs)
            .field("cors_origins", &self.cors_origins)
            .field("rate_limit_max", &self.rate_limit_max)
            .field("rate_limit_window_secs", &self.rate_limit_window_secs)
            .field("auth_rate_limit_max", &self.auth_rate_limit_max)
            .field("cookie_secure", &self.cookie_secure)
            .finish()
    }
}

const DEFAULT_CORS_ORIGINS: &str =
    "http://localhost:5173,http://localhost:1420,https://insightai.polytronx.com";

impl ApiConfig {
    pub fn from_env() -> anyhow::Result<Self> {
        fn parsed<T: std::str::FromStr>(key: &str, default: T) -> anyhow::Result<T> {
            match std::env::var(key) {
                Ok(v) => v
                    .parse()
                    .map_err(|_| anyhow::anyhow!("env var {key} has an unparsable value")),
                Err(_) => Ok(default),
            }
        }

        let jwt_secret = std::env::var("JWT_SECRET").context("missing required env JWT_SECRET")?;
        anyhow::ensure!(
            jwt_secret.len() >= 32,
            "JWT_SECRET must be at least 32 bytes"
        );
        let cors_origins = std::env::var("CORS_ORIGINS")
            .unwrap_or_else(|_| DEFAULT_CORS_ORIGINS.to_string())
            .split(',')
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty())
            .collect();

        Ok(Self {
            jwt_secret,
            access_ttl_secs: parsed("JWT_ACCESS_TTL_SECS", 900)?,
            refresh_ttl_secs: parsed("JWT_REFRESH_TTL_SECS", 1_209_600)?,
            cors_origins,
            rate_limit_max: parsed("RATE_LIMIT_MAX", 300)?,
            rate_limit_window_secs: parsed("RATE_LIMIT_WINDOW_SECS", 60)?,
            auth_rate_limit_max: parsed("AUTH_RATE_LIMIT_MAX", 10)?,
            cookie_secure: parsed("COOKIE_SECURE", true)?,
        })
    }
}

/// Cloneable handle threaded through every handler.
#[derive(Clone)]
pub struct AppState {
    pub stores: Arc<Stores>,
    pub queue: Arc<JobQueue>,
    pub cfg: Arc<ApiConfig>,
}
