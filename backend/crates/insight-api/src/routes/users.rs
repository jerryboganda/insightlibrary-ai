//! User administration (admin-gated): the tenant directory + invitations, and
//! per-user role/status changes, password reset, and session revocation. Shapes
//! match the api-client (`listUserDirectory`, `inviteUser`, `updateUser`,
//! `resetUserPassword`, `revokeUserSessions`).

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::{self, RequireAdmin};
use crate::error::ApiError;
use crate::state::AppState;
use insight_core::tenancy::{self, DirectoryUser, Invitation};

/// Invitations live for 72h (ported from the Node `INVITE_TTL_MS`).
const INVITE_TTL_SECS: i64 = 72 * 60 * 60;

fn initials(name: &Option<String>, email: &str) -> String {
    let source = name
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(email);
    let parts: Vec<&str> = source.split_whitespace().collect();
    let letters: String = if parts.len() >= 2 {
        format!(
            "{}{}",
            parts[0].chars().next().unwrap_or('?'),
            parts[1].chars().next().unwrap_or('?')
        )
    } else {
        source.chars().take(2).collect()
    };
    letters.to_uppercase()
}

fn iso(ts: chrono::DateTime<chrono::Utc>) -> String {
    ts.to_rfc3339()
}

/// `{base}` for invite URLs: WEB_ORIGIN env, else the first configured CORS
/// origin, else empty.
fn web_origin(state: &AppState) -> String {
    std::env::var("WEB_ORIGIN").ok().unwrap_or_else(|| {
        state
            .cfg
            .cors_origins
            .iter()
            .find(|o| o.starts_with("https://"))
            .or_else(|| state.cfg.cors_origins.first())
            .cloned()
            .unwrap_or_default()
    })
}

fn invite_url(base: &str, email: &str) -> String {
    let enc = urlencode(email);
    format!("{base}/login?email={enc}")
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn directory_item(u: &DirectoryUser) -> Value {
    json!({
        "id": u.id,
        "name": u.name.clone().unwrap_or_else(|| u.email.clone()),
        "email": u.email,
        "role": u.role,
        "initials": initials(&u.name, &u.email),
        "lastActive": u.last_active.map(iso).unwrap_or_default(),
        "status": u.status,
        "emailVerified": Value::Null,
        "createdAt": iso(u.created_at),
        "hasLogin": u.has_login,
    })
}

fn invitation_item(base: &str, inv: &Invitation) -> Value {
    let expired = inv.expires_at < chrono::Utc::now();
    json!({
        "id": inv.id,
        "email": inv.email,
        "role": inv.role,
        "status": if expired { "expired" } else { "pending" },
        "createdAt": iso(inv.created_at),
        "expiresAt": iso(inv.expires_at),
        "inviteUrl": invite_url(base, &inv.email),
    })
}

/// `GET /api/users` (admin) → `{ items, invitations, total }`.
pub async fn list_users(
    State(state): State<AppState>,
    RequireAdmin(user): RequireAdmin,
) -> Result<Json<Value>, ApiError> {
    let items = tenancy::list_directory(&state.stores.pool, user.tenant_id).await?;
    let invitations = tenancy::list_invitations(&state.stores.pool, user.tenant_id).await?;
    let base = web_origin(&state);
    Ok(Json(json!({
        "items": items.iter().map(directory_item).collect::<Vec<_>>(),
        "invitations": invitations.iter().map(|i| invitation_item(&base, i)).collect::<Vec<_>>(),
        "total": items.len(),
    })))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum UsersAction {
    Invite { email: String, role: Option<String> },
    RevokeInvite { invitation_id: Uuid },
}

/// `POST /api/users` (admin) — invite / revoke-invite.
pub async fn users_action(
    State(state): State<AppState>,
    RequireAdmin(user): RequireAdmin,
    Json(action): Json<UsersAction>,
) -> Result<Json<Value>, ApiError> {
    match action {
        UsersAction::Invite { email, role } => {
            let email = email.trim().to_lowercase();
            if !email.contains('@') {
                return Err(ApiError::bad_request("invalid email address"));
            }
            let role = role.as_deref().unwrap_or("viewer");
            let inv = tenancy::create_invitation(
                &state.stores.pool,
                user.tenant_id,
                &email,
                role,
                user.user_id,
                INVITE_TTL_SECS,
            )
            .await?;
            let base = web_origin(&state);
            Ok(Json(json!({
                "id": inv.id,
                "email": inv.email,
                "role": inv.role,
                "status": "pending",
                "expiresAt": iso(inv.expires_at),
                "inviteUrl": invite_url(&base, &inv.email),
                "emailSent": false,
            })))
        }
        UsersAction::RevokeInvite { invitation_id } => {
            let done =
                tenancy::cancel_invitation(&state.stores.pool, user.tenant_id, invitation_id)
                    .await?;
            if !done {
                return Err(ApiError::not_found("invitation not found"));
            }
            Ok(Json(json!({ "ok": true })))
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct PatchUserBody {
    role: Option<String>,
    status: Option<String>,
}

/// `PATCH /api/users/{id}` (admin) — update role and/or status.
pub async fn update_user(
    State(state): State<AppState>,
    RequireAdmin(admin): RequireAdmin,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchUserBody>,
) -> Result<Json<Value>, ApiError> {
    if body.role.is_none() && body.status.is_none() {
        return Err(ApiError::bad_request("nothing to update"));
    }
    if let Some(status) = &body.status {
        if status != "active" && status != "suspended" {
            return Err(ApiError::bad_request("status must be active or suspended"));
        }
    }
    let updated = tenancy::update_user(
        &state.stores.pool,
        admin.tenant_id,
        id,
        body.role.as_deref(),
        body.status.as_deref(),
    )
    .await?
    .ok_or_else(|| ApiError::not_found("user not found"))?;

    // Suspending a user kills their live sessions.
    if body.status.as_deref() == Some("suspended") {
        let jtis =
            tenancy::revoke_other_sessions(&state.stores.pool, admin.tenant_id, id, None).await?;
        for jti in jtis {
            let _ = auth::revoke_refresh(&state, jti).await;
        }
    }
    Ok(Json(
        json!({ "id": id, "role": updated.0, "status": updated.1 }),
    ))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum UserIdAction {
    ResetPassword,
    RevokeSessions,
}

/// A random, human-typeable temporary password. Two v4 UUIDs (CSPRNG-backed)
/// give 128 bits of entropy without pulling in another crate.
fn temp_password() -> String {
    let a = Uuid::new_v4().simple().to_string();
    let b = Uuid::new_v4().simple().to_string();
    format!("Il-{}{}", &a[..10], &b[..6])
}

/// `POST /api/users/{id}` (admin) — reset-password / revoke-sessions.
pub async fn user_id_action(
    State(state): State<AppState>,
    RequireAdmin(admin): RequireAdmin,
    Path(id): Path<Uuid>,
    Json(action): Json<UserIdAction>,
) -> Result<Json<Value>, ApiError> {
    match action {
        UserIdAction::ResetPassword => {
            let temp = temp_password();
            let done =
                tenancy::set_user_password(&state.stores.pool, admin.tenant_id, id, &temp).await?;
            if !done {
                return Err(ApiError::not_found("user not found"));
            }
            // Reset invalidates existing sessions.
            let jtis =
                tenancy::revoke_other_sessions(&state.stores.pool, admin.tenant_id, id, None)
                    .await?;
            for jti in jtis {
                let _ = auth::revoke_refresh(&state, jti).await;
            }
            Ok(Json(json!({ "ok": true, "tempPassword": temp })))
        }
        UserIdAction::RevokeSessions => {
            let jtis =
                tenancy::revoke_other_sessions(&state.stores.pool, admin.tenant_id, id, None)
                    .await?;
            let revoked = jtis.len();
            for jti in jtis {
                let _ = auth::revoke_refresh(&state, jti).await;
            }
            Ok(Json(json!({ "ok": true, "revoked": revoked })))
        }
    }
}
