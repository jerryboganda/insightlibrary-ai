//! Auth endpoints: sign-up, sign-in, refresh (with jti rotation), sign-out,
//! and the anonymous-friendly session probe.
//!
//! Every success response carries the tokens BOTH ways: HTTP-only cookies
//! for the web shell and `{ accessToken, refreshToken }` in the body for the
//! Tauri Bearer path.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::{self, AuthedUser, ACCESS_COOKIE, REFRESH_COOKIE};
use crate::error::ApiError;
use crate::state::AppState;
use insight_core::tenancy::{self, AuthedIdentity, SignUpError};

#[derive(Debug, Deserialize)]
pub struct SignUpBody {
    email: String,
    password: String,
    name: String,
}

#[derive(Debug, Deserialize)]
pub struct SignInBody {
    email: String,
    password: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshBody {
    refresh_token: Option<String>,
}

/// Minimal-but-real email shape check (full validation is the mail loop's
/// job in a later phase).
fn valid_email(email: &str) -> bool {
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !domain.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !email.contains(char::is_whitespace)
}

fn build_cookie(
    name: &'static str,
    value: String,
    path: &'static str,
    secure: bool,
) -> Cookie<'static> {
    Cookie::build((name, value))
        .path(path)
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(secure)
        .build()
}

/// Mint access+refresh, allowlist the refresh jti, set both cookies.
async fn issue_session(
    state: &AppState,
    jar: CookieJar,
    user_id: Uuid,
    tenant_id: Uuid,
    role: &str,
) -> Result<(CookieJar, String, String), ApiError> {
    let (access, _) = auth::mint(&state.cfg, user_id, tenant_id, role, "access")?;
    let (refresh, refresh_jti) = auth::mint(&state.cfg, user_id, tenant_id, role, "refresh")?;
    auth::allow_refresh(state, refresh_jti, user_id).await?;

    let secure = state.cfg.cookie_secure;
    let jar = jar
        .add(build_cookie(ACCESS_COOKIE, access.clone(), "/", secure))
        .add(build_cookie(
            REFRESH_COOKIE,
            refresh.clone(),
            "/api/auth",
            secure,
        ));
    Ok((jar, access, refresh))
}

/// `SessionUser` per packages/schemas sessionUserSchema: org/tenant fields
/// are flattened INSIDE `user` (the separate `org` key is kept as an
/// additive convenience).
fn session_user(
    id: Uuid,
    name: &Option<String>,
    email: &str,
    role: &str,
    tenant_id: Uuid,
    tenant_name: &str,
) -> Value {
    json!({
        "id": id,
        "name": name,
        "email": email,
        "role": role,
        "orgId": tenant_id,
        "orgName": tenant_name,
        "tenantId": tenant_id,
    })
}

fn identity_body(identity: &AuthedIdentity, access: &str, refresh: &str) -> Value {
    json!({
        "user": session_user(
            identity.user.id,
            &identity.user.name,
            &identity.user.email,
            &identity.user.role,
            identity.tenant.id,
            &identity.tenant.name,
        ),
        "org": { "id": identity.tenant.id, "name": identity.tenant.name },
        "accessToken": access,
        "refreshToken": refresh,
    })
}

/// `POST /api/auth/sign-up`
pub async fn sign_up(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(body): Json<SignUpBody>,
) -> Result<(CookieJar, Json<Value>), ApiError> {
    let email = body.email.trim().to_lowercase();
    if !valid_email(&email) {
        return Err(ApiError::bad_request("invalid email address"));
    }
    if body.password.chars().count() < 8 {
        return Err(ApiError::bad_request(
            "password must be at least 8 characters",
        ));
    }
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::bad_request("name is required"));
    }

    let identity = tenancy::sign_up(&state.stores.pool, &email, &body.password, name)
        .await
        .map_err(|e| match e {
            SignUpError::EmailTaken => ApiError::conflict("email already registered"),
            SignUpError::Other(e) => e.into(),
        })?;

    let (jar, access, refresh) = issue_session(
        &state,
        jar,
        identity.user.id,
        identity.tenant.id,
        &identity.user.role,
    )
    .await?;
    Ok((jar, Json(identity_body(&identity, &access, &refresh))))
}

/// `POST /api/auth/sign-in` — generic 401 on any credential failure (no
/// user-enumeration; a dummy argon2 verify runs for unknown emails).
pub async fn sign_in(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(body): Json<SignInBody>,
) -> Result<(CookieJar, Json<Value>), ApiError> {
    let identity = tenancy::verify_credentials(&state.stores.pool, &body.email, &body.password)
        .await?
        .ok_or_else(|| ApiError::unauthorized("invalid email or password"))?;

    let (jar, access, refresh) = issue_session(
        &state,
        jar,
        identity.user.id,
        identity.tenant.id,
        &identity.user.role,
    )
    .await?;
    Ok((jar, Json(identity_body(&identity, &access, &refresh))))
}

/// Refresh token from the `insight_refresh` cookie or `{ refreshToken }`
/// body (the body may be absent entirely).
fn refresh_token_from(jar: &CookieJar, body: &Bytes) -> Option<String> {
    if let Some(cookie) = jar.get(REFRESH_COOKIE) {
        return Some(cookie.value().to_string());
    }
    if body.is_empty() {
        return None;
    }
    serde_json::from_slice::<RefreshBody>(body)
        .ok()
        .and_then(|b| b.refresh_token)
}

/// `POST /api/auth/refresh` — verifies + rotates the refresh jti and issues
/// a fresh access+refresh pair.
pub async fn refresh(
    State(state): State<AppState>,
    jar: CookieJar,
    body: Bytes,
) -> Result<(CookieJar, Json<Value>), ApiError> {
    let token = refresh_token_from(&jar, &body)
        .ok_or_else(|| ApiError::unauthorized("missing refresh token"))?;
    let claims = auth::verify(&state.cfg, &token, "refresh")?;
    // Atomic consume: exactly one concurrent refresh with this jti rotates.
    if !auth::consume_refresh(&state, claims.jti).await? {
        return Err(ApiError::unauthorized("refresh token revoked"));
    }

    let (jar, access, refresh) =
        issue_session(&state, jar, claims.sub, claims.ten, &claims.role).await?;
    Ok((
        jar,
        Json(json!({ "accessToken": access, "refreshToken": refresh })),
    ))
}

/// `POST /api/auth/sign-out` — revokes the presented refresh jti (cookie or
/// body) and clears both auth cookies. Always succeeds.
pub async fn sign_out(
    State(state): State<AppState>,
    jar: CookieJar,
    body: Bytes,
) -> Result<(CookieJar, Json<Value>), ApiError> {
    if let Some(token) = refresh_token_from(&jar, &body) {
        if let Ok(claims) = auth::verify(&state.cfg, &token, "refresh") {
            auth::revoke_refresh(&state, claims.jti).await?;
        }
    }
    let jar = jar
        .remove(Cookie::build((ACCESS_COOKIE, "")).path("/").build())
        .remove(
            Cookie::build((REFRESH_COOKIE, ""))
                .path("/api/auth")
                .build(),
        );
    Ok((jar, Json(json!({ "ok": true }))))
}

/// `GET /api/session` — 200 with `authenticated:false` for anonymous
/// callers (never 401).
pub async fn session(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    // sessionResponseSchema declares `user` as nullable-but-present, so the
    // anonymous branch emits an explicit null rather than omitting the key.
    let anonymous = Ok(Json(json!({ "authenticated": false, "user": null })));

    let Some(user) = AuthedUser::maybe(&headers, &state.cfg) else {
        return anonymous;
    };
    let Some(row) = tenancy::get_user(&state.stores.pool, user.tenant_id, user.user_id).await?
    else {
        return anonymous;
    };
    let Some(tenant) = tenancy::get_tenant(&state.stores.pool, user.tenant_id).await? else {
        return anonymous;
    };
    Ok(Json(json!({
        "authenticated": true,
        "user": session_user(row.id, &row.name, &row.email, &row.role, tenant.id, &tenant.name),
        "org": { "id": tenant.id, "name": tenant.name },
    })))
}
