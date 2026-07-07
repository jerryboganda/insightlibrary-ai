//! JWT mint/verify (HS256), the refresh-token allowlist, and the
//! [`AuthedUser`] extractor (Bearer header OR `insight_access` cookie).

use axum::extract::FromRequestParts;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use axum_extra::extract::cookie::CookieJar;
use chrono::Utc;
use insight_core::storage::Cache;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::ApiError;
use crate::state::{ApiConfig, AppState};

/// Cookie carrying the access JWT for browser clients.
pub const ACCESS_COOKIE: &str = "insight_access";
/// Cookie carrying the refresh JWT (scoped to `/api/auth`).
pub const REFRESH_COOKIE: &str = "insight_refresh";

/// JWT claims for both access and refresh tokens (`typ` disambiguates).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    /// User id.
    pub sub: Uuid,
    /// Tenant id.
    pub ten: Uuid,
    pub role: String,
    /// `"access"` or `"refresh"`.
    pub typ: String,
    pub exp: i64,
    pub iat: i64,
    /// Token id; refresh jtis live in a Redis allowlist until revoked.
    pub jti: Uuid,
    /// Session id — stable across refresh rotations, keys the `auth_sessions`
    /// row so a device can identify + revoke itself. `#[serde(default)]` keeps
    /// pre-session tokens deserializable (they resolve to the nil uuid).
    #[serde(default)]
    pub sid: Uuid,
}

/// Mint a token of `typ` for the user, bound to session `sid`. Returns
/// `(token, jti)`.
pub fn mint(
    cfg: &ApiConfig,
    user_id: Uuid,
    tenant_id: Uuid,
    role: &str,
    typ: &str,
    sid: Uuid,
) -> anyhow::Result<(String, Uuid)> {
    let ttl = match typ {
        "refresh" => cfg.refresh_ttl_secs,
        _ => cfg.access_ttl_secs,
    };
    let now = Utc::now().timestamp();
    let jti = Uuid::new_v4();
    let claims = Claims {
        sub: user_id,
        ten: tenant_id,
        role: role.to_string(),
        typ: typ.to_string(),
        exp: now + ttl as i64,
        iat: now,
        jti,
        sid,
    };
    let token = jsonwebtoken::encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(cfg.jwt_secret.as_bytes()),
    )
    .map_err(|e| anyhow::anyhow!("jwt encode: {e}"))?;
    Ok((token, jti))
}

/// Verify signature + expiry + `typ`. Errors map to 401 at call sites.
pub fn verify(cfg: &ApiConfig, token: &str, expected_typ: &str) -> Result<Claims, ApiError> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_exp = true;
    let data = jsonwebtoken::decode::<Claims>(
        token,
        &DecodingKey::from_secret(cfg.jwt_secret.as_bytes()),
        &validation,
    )
    .map_err(|_| ApiError::unauthorized("invalid or expired token"))?;
    if data.claims.typ != expected_typ {
        return Err(ApiError::unauthorized("wrong token type"));
    }
    Ok(data.claims)
}

fn refresh_key(jti: Uuid) -> String {
    format!("refresh:{jti}")
}

/// Add a refresh jti to the allowlist for the refresh TTL.
pub async fn allow_refresh(state: &AppState, jti: Uuid, user_id: Uuid) -> anyhow::Result<()> {
    state
        .stores
        .cache
        .set_with_ttl(
            &refresh_key(jti),
            &user_id.to_string(),
            state.cfg.refresh_ttl_secs,
        )
        .await
}

/// Atomically consume a refresh jti (GETDEL): `true` when it was still
/// allowlisted AND this call removed it. Two concurrent refreshes with the
/// same token cannot both win — check-then-delete would let both rotate.
pub async fn consume_refresh(state: &AppState, jti: Uuid) -> anyhow::Result<bool> {
    Ok(state.stores.cache.take(&refresh_key(jti)).await?.is_some())
}

/// Drop a refresh jti (rotation and sign-out).
pub async fn revoke_refresh(state: &AppState, jti: Uuid) -> anyhow::Result<()> {
    state.stores.cache.del(&refresh_key(jti)).await
}

/// Pull a candidate access token from `Authorization: Bearer …` or the
/// `insight_access` cookie.
pub fn access_token_from_parts(headers: &axum::http::HeaderMap) -> Option<String> {
    if let Some(value) = headers.get(AUTHORIZATION) {
        if let Ok(value) = value.to_str() {
            if let Some(token) = value.strip_prefix("Bearer ") {
                return Some(token.trim().to_string());
            }
        }
    }
    let jar = CookieJar::from_headers(headers);
    jar.get(ACCESS_COOKIE).map(|c| c.value().to_string())
}

/// Authenticated caller identity, from a verified access token.
#[derive(Debug, Clone)]
pub struct AuthedUser {
    pub user_id: Uuid,
    pub tenant_id: Uuid,
    /// Per-org role (owner/admin/editor/viewer), used by [`RequireAdmin`].
    pub role: String,
    /// Session id carried in the token (nil for pre-session tokens).
    pub session_id: Uuid,
}

impl AuthedUser {
    fn from_claims(claims: Claims) -> Self {
        Self {
            user_id: claims.sub,
            tenant_id: claims.ten,
            role: claims.role,
            session_id: claims.sid,
        }
    }

    /// Non-rejecting variant for endpoints like `/api/session` that must
    /// answer 200 for anonymous callers.
    pub fn maybe(headers: &axum::http::HeaderMap, cfg: &ApiConfig) -> Option<Self> {
        let token = access_token_from_parts(headers)?;
        verify(cfg, &token, "access").ok().map(Self::from_claims)
    }
}

impl FromRequestParts<AppState> for AuthedUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        // The rate-limit middleware may have already verified the token.
        if let Some(user) = parts.extensions.get::<AuthedUser>() {
            return Ok(user.clone());
        }
        let token = access_token_from_parts(&parts.headers)
            .ok_or_else(|| ApiError::unauthorized("missing credentials"))?;
        let claims = verify(&state.cfg, &token, "access")?;
        Ok(Self::from_claims(claims))
    }
}

/// Extractor that requires the caller's org role to be `admin` or higher
/// (admin/owner). Rejects anonymous callers 401 and under-privileged 403.
/// Role comes from the short-lived access token (a demotion takes effect
/// within the access TTL).
#[derive(Debug, Clone)]
pub struct RequireAdmin(pub AuthedUser);

impl FromRequestParts<AppState> for RequireAdmin {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let user = AuthedUser::from_request_parts(parts, state).await?;
        if insight_core::tenancy::role_rank(&user.role) < insight_core::tenancy::role_rank("admin")
        {
            return Err(ApiError::forbidden("requires admin role or higher"));
        }
        Ok(Self(user))
    }
}

/// Extractor that requires the caller's PLATFORM role to be `super_admin`
/// (cross-tenant operator). Looked up in the DB per request (rare paths:
/// system settings, org console).
#[derive(Debug, Clone)]
pub struct RequireSuperAdmin(pub AuthedUser);

impl FromRequestParts<AppState> for RequireSuperAdmin {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let user = AuthedUser::from_request_parts(parts, state).await?;
        let platform_role = insight_core::tenancy::get_platform_role(
            &state.stores.pool,
            user.tenant_id,
            user.user_id,
        )
        .await
        .map_err(ApiError::from)?;
        if platform_role.as_deref() != Some("super_admin") {
            return Err(ApiError::forbidden("requires super-admin"));
        }
        Ok(Self(user))
    }
}
