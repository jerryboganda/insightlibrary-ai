//! Redis fixed-window rate limiting, two flavors:
//!
//! - [`rate_limit`]: per-tenant (`rl:tenant:{id}`), on the protected
//!   sub-router. Anonymous/invalid-token requests pass through — handlers
//!   reject them with 401 anyway.
//! - [`auth_rate_limit`]: per-client-IP (`rl:auth:{ip}`), on the anonymous
//!   auth endpoints. Keying on the tenant would be useless pre-auth, and an
//!   unlimited sign-in endpoint is both a credential brute-force surface and
//!   an argon2 CPU/memory-exhaustion DoS (every attempt verifies a real or
//!   dummy hash at ~19 MiB, t=2).

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use insight_core::storage::Cache;

use crate::auth::{self, AuthedUser};
use crate::error::ApiError;
use crate::state::AppState;

/// Count a hit on `key` in a fixed window of `window` seconds; `Some(429)`
/// once the count exceeds `max`. Fails open on Redis errors (a Redis blip
/// should not take the API down). The window TTL is healed on every request
/// (not just count==1) so a lost EXPIRE cannot leave an immortal counter
/// that permanently 429s the caller.
async fn fixed_window(state: &AppState, key: &str, max: u64, window: u64) -> Option<Response> {
    let count = match state.stores.cache.incr(key).await {
        Ok(count) => count,
        Err(e) => {
            tracing::warn!(error = format!("{e:#}"), "rate-limit INCR failed; skipping");
            return None;
        }
    };
    // TTL of None means the key exists without an expiry (first hit, or a
    // previous EXPIRE was lost) — (re)arm the window.
    match state.stores.cache.ttl(key).await {
        Ok(None) => {
            if let Err(e) = state.stores.cache.expire(key, window as i64).await {
                tracing::warn!(error = format!("{e:#}"), "rate-limit EXPIRE failed");
            }
        }
        Ok(Some(_)) => {}
        Err(e) => tracing::warn!(error = format!("{e:#}"), "rate-limit TTL failed"),
    }
    if count as u64 <= max {
        return None;
    }
    let retry_after = state
        .stores
        .cache
        .ttl(key)
        .await
        .ok()
        .flatten()
        .filter(|t| *t > 0)
        .unwrap_or(window as i64);
    let mut response = ApiError::new(
        StatusCode::TOO_MANY_REQUESTS,
        "rate_limited",
        "too many requests; slow down",
    )
    .into_response();
    if let Ok(value) = retry_after.to_string().parse() {
        response.headers_mut().insert("Retry-After", value);
    }
    Some(response)
}

/// Best-effort client IP: leftmost `X-Forwarded-For` hop (set by the
/// Cloudflare tunnel / reverse proxy in production), falling back to the
/// socket peer address. Spoofable only by direct (non-proxied) callers,
/// which the production deployment does not expose.
fn client_ip(req: &Request) -> Option<String> {
    if let Some(xff) = req.headers().get("x-forwarded-for") {
        if let Ok(value) = xff.to_str() {
            if let Some(first) = value.split(',').next() {
                let first = first.trim();
                if !first.is_empty() {
                    return Some(first.to_string());
                }
            }
        }
    }
    req.extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(addr)| addr.ip().to_string())
}

/// Per-tenant limiter for authenticated traffic.
pub async fn rate_limit(State(state): State<AppState>, mut req: Request, next: Next) -> Response {
    // Anonymous requests pass through: the handlers reject them with 401
    // (or, for /api/session, answer authenticated:false).
    let Some(token) = auth::access_token_from_parts(req.headers()) else {
        return next.run(req).await;
    };
    let Ok(claims) = auth::verify(&state.cfg, &token, "access") else {
        return next.run(req).await;
    };
    let user = AuthedUser {
        user_id: claims.sub,
        tenant_id: claims.ten,
        role: claims.role.clone(),
    };
    let tenant_id = user.tenant_id;
    // Let handlers reuse the verification via the extractor.
    req.extensions_mut().insert(user);

    let key = format!("rl:tenant:{tenant_id}");
    let max = state.cfg.rate_limit_max;
    let window = state.cfg.rate_limit_window_secs;
    if let Some(rejection) = fixed_window(&state, &key, max, window).await {
        return rejection;
    }
    next.run(req).await
}

/// Per-IP limiter for the anonymous auth endpoints (sign-in/sign-up/
/// refresh/sign-out) — applied BEFORE any credential or token work.
pub async fn auth_rate_limit(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let Some(ip) = client_ip(&req) else {
        // No peer info (should not happen with connect-info wired); fail
        // open rather than collapsing all callers into one bucket.
        tracing::warn!("auth rate limit: no client ip available; skipping");
        return next.run(req).await;
    };
    let key = format!("rl:auth:{ip}");
    let max = state.cfg.auth_rate_limit_max;
    let window = state.cfg.rate_limit_window_secs;
    if let Some(rejection) = fixed_window(&state, &key, max, window).await {
        return rejection;
    }
    next.run(req).await
}
