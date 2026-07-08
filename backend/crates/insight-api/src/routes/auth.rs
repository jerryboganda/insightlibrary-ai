//! Auth endpoints: sign-up (invite-aware), sign-in, refresh (jti rotation +
//! session touch), sign-out, the anonymous-friendly session probe, and the
//! device-session list/revoke surface the settings page drives.
//!
//! Every success response carries the tokens BOTH ways: HTTP-only cookies for
//! the web shell and `{ accessToken, refreshToken }` in the body for the Tauri
//! Bearer path. Sessions are persisted in `auth_sessions` (keyed by the JWT
//! `sid`) so a device can list and revoke itself; the Redis refresh allowlist
//! stays the fast per-request check.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use chrono::Utc;
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

/// Best-effort user-agent / client-ip for the device list (leftmost
/// `X-Forwarded-For` hop, set by the Cloudflare tunnel in production).
fn user_agent(headers: &HeaderMap) -> Option<String> {
    headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}
fn client_ip(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn set_auth_cookies(jar: CookieJar, access: &str, refresh: &str, secure: bool) -> CookieJar {
    jar.add(build_cookie(ACCESS_COOKIE, access.to_string(), "/", secure))
        .add(build_cookie(
            REFRESH_COOKIE,
            refresh.to_string(),
            "/api/auth",
            secure,
        ))
}

/// Mint access+refresh for a NEW session: allocate a `sid`, allowlist the
/// refresh jti, persist the session row, and set both cookies.
async fn start_session(
    state: &AppState,
    jar: CookieJar,
    headers: &HeaderMap,
    user_id: Uuid,
    tenant_id: Uuid,
    role: &str,
) -> Result<(CookieJar, String, String), ApiError> {
    let sid = Uuid::new_v4();
    let (access, _) = auth::mint(&state.cfg, user_id, tenant_id, role, "access", sid)?;
    let (refresh, refresh_jti) = auth::mint(&state.cfg, user_id, tenant_id, role, "refresh", sid)?;
    auth::allow_refresh(state, refresh_jti, user_id).await?;

    let expires_at = Utc::now() + chrono::Duration::seconds(state.cfg.refresh_ttl_secs as i64);
    tenancy::insert_session(
        &state.stores.pool,
        tenant_id,
        sid,
        user_id,
        refresh_jti,
        user_agent(headers).as_deref(),
        client_ip(headers).as_deref(),
        expires_at,
    )
    .await?;

    let jar = set_auth_cookies(jar, &access, &refresh, state.cfg.cookie_secure);
    Ok((jar, access, refresh))
}

/// `SessionUser` per packages/schemas sessionUserSchema. `name` is a required
/// string on the wire (falls back to email) and `role` is normalized to the
/// 4-value enum so the frontend Zod parse never rejects.
fn session_user(
    id: Uuid,
    name: &Option<String>,
    email: &str,
    role: &str,
    tenant_id: Uuid,
    tenant_name: &str,
) -> Value {
    let name = name
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(email);
    json!({
        "id": id,
        "name": name,
        "email": email,
        "role": tenancy::normalize_role(role),
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

/// `POST /api/auth/sign-up` — honors a pending invitation for the email (joins
/// the inviting org with the invited role); otherwise creates a personal org.
pub async fn sign_up(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
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

    let identity = tenancy::sign_up_with_invite(&state.stores.pool, &email, &body.password, name)
        .await
        .map_err(|e| match e {
            SignUpError::EmailTaken => ApiError::conflict("email already registered"),
            SignUpError::Other(e) => e.into(),
        })?;

    let (jar, access, refresh) = start_session(
        &state,
        jar,
        &headers,
        identity.user.id,
        identity.tenant.id,
        &identity.user.role,
    )
    .await?;
    Ok((jar, Json(identity_body(&identity, &access, &refresh))))
}

/// `POST /api/auth/sign-in` — generic 401 on any credential failure.
pub async fn sign_in(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(body): Json<SignInBody>,
) -> Result<(CookieJar, Json<Value>), ApiError> {
    let identity = tenancy::verify_credentials(&state.stores.pool, &body.email, &body.password)
        .await?
        .ok_or_else(|| ApiError::unauthorized("invalid email or password"))?;

    // A suspended org cannot start new sessions.
    let suspended: Option<bool> = sqlx::query_scalar("SELECT suspended FROM tenants WHERE id = $1")
        .bind(identity.tenant.id)
        .fetch_optional(&state.stores.pool)
        .await
        .map_err(|e| ApiError::from(anyhow::Error::from(e)))?;
    if suspended == Some(true) {
        return Err(ApiError::forbidden("this workspace is suspended"));
    }

    let (jar, access, refresh) = start_session(
        &state,
        jar,
        &headers,
        identity.user.id,
        identity.tenant.id,
        &identity.user.role,
    )
    .await?;
    Ok((jar, Json(identity_body(&identity, &access, &refresh))))
}

/// Refresh token from the `insight_refresh` cookie or `{ refreshToken }` body.
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

/// `POST /api/auth/refresh` — verify + rotate the refresh jti, reusing the same
/// session id, and touch the session row.
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

    let sid = claims.sid;
    let (access, _) = auth::mint(
        &state.cfg,
        claims.sub,
        claims.ten,
        &claims.role,
        "access",
        sid,
    )?;
    let (refresh, refresh_jti) = auth::mint(
        &state.cfg,
        claims.sub,
        claims.ten,
        &claims.role,
        "refresh",
        sid,
    )?;

    // Rotate the stored jti; a revoked/missing session (nil sid on legacy
    // tokens) fails closed.
    if sid.is_nil()
        || !tenancy::touch_session(&state.stores.pool, claims.ten, sid, refresh_jti).await?
    {
        return Err(ApiError::unauthorized("session revoked"));
    }
    auth::allow_refresh(&state, refresh_jti, claims.sub).await?;

    let jar = set_auth_cookies(jar, &access, &refresh, state.cfg.cookie_secure);
    Ok((
        jar,
        Json(json!({ "accessToken": access, "refreshToken": refresh })),
    ))
}

/// `POST /api/auth/sign-out` — revoke the presented refresh jti + its session
/// row, and clear both auth cookies. Always succeeds.
pub async fn sign_out(
    State(state): State<AppState>,
    jar: CookieJar,
    body: Bytes,
) -> Result<(CookieJar, Json<Value>), ApiError> {
    if let Some(token) = refresh_token_from(&jar, &body) {
        if let Ok(claims) = auth::verify(&state.cfg, &token, "refresh") {
            auth::revoke_refresh(&state, claims.jti).await?;
            if !claims.sid.is_nil() {
                let _ = tenancy::revoke_session(&state.stores.pool, claims.ten, claims.sid).await;
            }
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

/// `GET /api/session` — 200 with `authenticated:false` for anonymous callers.
/// Adds `sessionToken` (the current sid) so the frontend auth shim's
/// getSession can resolve `data.session.token`.
pub async fn session(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
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
    let platform_role =
        tenancy::get_platform_role(&state.stores.pool, user.tenant_id, user.user_id)
            .await
            .unwrap_or(None)
            .unwrap_or_else(|| "user".into());
    Ok(Json(json!({
        "authenticated": true,
        "user": session_user(row.id, &row.name, &row.email, &row.role, tenant.id, &tenant.name),
        "org": { "id": tenant.id, "name": tenant.name },
        "sessionToken": user.session_id,
        "platformRole": platform_role,
    })))
}

// ---------------------------------------------------------------------------
// Device sessions (settings page)
// ---------------------------------------------------------------------------

/// `GET /api/auth/sessions` — the caller's live sessions. `token` = the session
/// id (what the frontend passes back to revoke); `current` marks this device.
pub async fn list_sessions(
    State(state): State<AppState>,
    user: AuthedUser,
) -> Result<Json<Value>, ApiError> {
    let rows = tenancy::list_sessions(&state.stores.pool, user.tenant_id, user.user_id).await?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(|s| {
            json!({
                "id": s.id,
                "token": s.id,
                "userAgent": s.user_agent,
                "ipAddress": s.ip_address,
                "createdAt": s.created_at,
                "expiresAt": s.expires_at,
                "lastSeenAt": s.last_seen_at,
                "current": s.id == user.session_id,
            })
        })
        .collect();
    Ok(Json(json!({ "items": items })))
}

#[derive(Debug, Deserialize)]
pub struct RevokeSessionBody {
    /// Session id (the frontend calls this field `token`).
    token: Uuid,
}

/// `POST /api/auth/sessions/revoke` — revoke one session by id.
pub async fn revoke_session(
    State(state): State<AppState>,
    user: AuthedUser,
    Json(body): Json<RevokeSessionBody>,
) -> Result<Json<Value>, ApiError> {
    if let Some(jti) =
        tenancy::revoke_session(&state.stores.pool, user.tenant_id, body.token).await?
    {
        auth::revoke_refresh(&state, jti).await?;
    }
    Ok(Json(json!({ "ok": true })))
}

/// `POST /api/auth/sessions/revoke-others` — revoke every session but this one.
pub async fn revoke_other_sessions(
    State(state): State<AppState>,
    user: AuthedUser,
) -> Result<Json<Value>, ApiError> {
    let jtis = tenancy::revoke_other_sessions(
        &state.stores.pool,
        user.tenant_id,
        user.user_id,
        Some(user.session_id),
    )
    .await?;
    let revoked = jtis.len();
    for jti in jtis {
        let _ = auth::revoke_refresh(&state, jti).await;
    }
    Ok(Json(json!({ "ok": true, "revoked": revoked })))
}
