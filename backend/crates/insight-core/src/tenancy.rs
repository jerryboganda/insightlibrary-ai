//! Tenancy + credential auth: tenant/user domain types, the sign-up flow
//! (tenant + owner user in one transaction), and password verification.
//!
//! Passwords are hashed with argon2id (crate defaults). Sign-in runs before
//! any tenant context exists, so the user lookup uses the SELECT-only
//! `auth_email_lookup` RLS policy (migration 0009): the transaction sets
//! `app.auth_email` to the email being authenticated and can then see only
//! that email's rows. Plans/quotas/entitlements land in Phase 8.

use std::sync::LazyLock;

use anyhow::Context;
use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::storage::set_tenant;

/// Tenant row (tenancy root; not itself RLS-protected).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Tenant {
    pub id: Uuid,
    pub kind: String,
    pub name: String,
    pub plan: String,
    pub created_at: DateTime<Utc>,
}

/// User row, minus the password hash (which never leaves this module).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct User {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub email: String,
    pub name: Option<String>,
    pub role: String,
    pub locale: String,
    pub created_at: DateTime<Utc>,
}

/// Result of a successful sign-up or credential verification.
#[derive(Debug, Clone)]
pub struct AuthedIdentity {
    pub user: User,
    pub tenant: Tenant,
}

/// Sign-up failure modes the API maps to distinct status codes.
#[derive(Debug, thiserror::Error)]
pub enum SignUpError {
    #[error("email already registered")]
    EmailTaken,
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

/// Hash of a throwaway password, verified against when the email does not
/// match any user so that sign-in latency does not reveal account existence.
static DUMMY_HASH: LazyLock<String> = LazyLock::new(|| {
    hash_password("insight-dummy-password-for-timing").expect("hashing a static dummy password")
});

/// Argon2id hash (crate defaults: 19 MiB, t=2, p=1) with a fresh salt.
pub fn hash_password(password: &str) -> anyhow::Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| anyhow::anyhow!("argon2 hash: {e}"))?;
    Ok(hash.to_string())
}

/// `true` when `password` matches the stored `hash`.
pub fn verify_password(password: &str, hash: &str) -> anyhow::Result<bool> {
    let parsed = PasswordHash::new(hash).map_err(|e| anyhow::anyhow!("parse stored hash: {e}"))?;
    Ok(Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok())
}

/// Create a personal tenant (`kind = 'user'`) plus its owner user in ONE
/// transaction: either both exist afterwards or neither does.
pub async fn sign_up(
    pool: &PgPool,
    email: &str,
    password: &str,
    name: &str,
) -> Result<AuthedIdentity, SignUpError> {
    let email = email.trim().to_lowercase();
    let password_hash = hash_password(password)?;

    let mut tx = pool.begin().await.context("begin sign-up tx")?;
    let tenant: Tenant = sqlx::query_as(
        "INSERT INTO tenants (kind, name, plan) VALUES ('user', $1, 'free') \
         RETURNING id, kind, name, plan, created_at",
    )
    .bind(name)
    .fetch_one(&mut *tx)
    .await
    .context("insert tenant")?;

    set_tenant(&mut tx, tenant.id).await?;
    let inserted = sqlx::query_as::<_, User>(
        "INSERT INTO users (tenant_id, email, name, role, password_hash) \
         VALUES ($1, $2, $3, 'owner', $4) \
         RETURNING id, tenant_id, email, name, role, locale, created_at",
    )
    .bind(tenant.id)
    .bind(&email)
    .bind(name)
    .bind(&password_hash)
    .fetch_one(&mut *tx)
    .await;

    let user = match inserted {
        Ok(user) => user,
        Err(sqlx::Error::Database(db)) if db.is_unique_violation() => {
            return Err(SignUpError::EmailTaken);
        }
        Err(e) => return Err(anyhow::Error::from(e).context("insert owner user").into()),
    };
    tx.commit().await.context("commit sign-up tx")?;
    Ok(AuthedIdentity { user, tenant })
}

/// Verify email + password. Returns `None` on unknown email OR wrong
/// password — indistinguishable to the caller, and an argon2 verification
/// runs in both cases so response timing stays comparable.
pub async fn verify_credentials(
    pool: &PgPool,
    email: &str,
    password: &str,
) -> anyhow::Result<Option<AuthedIdentity>> {
    let email = email.trim().to_lowercase();
    let found = fetch_user_for_auth(pool, &email).await?;

    let Some((user, password_hash)) = found else {
        // Burn comparable CPU before returning "no".
        let _ = verify_password(password, &DUMMY_HASH);
        return Ok(None);
    };
    let Some(password_hash) = password_hash else {
        let _ = verify_password(password, &DUMMY_HASH);
        return Ok(None);
    };
    if !verify_password(password, &password_hash)? {
        return Ok(None);
    }

    let tenant = get_tenant(pool, user.tenant_id)
        .await?
        .context("tenant row missing for authenticated user")?;
    Ok(Some(AuthedIdentity { user, tenant }))
}

/// Fetch a user (and password hash) by email with NO tenant context, via the
/// `auth_email_lookup` policy: the transaction declares the email it is
/// authenticating and can see only rows with exactly that email.
async fn fetch_user_for_auth(
    pool: &PgPool,
    email: &str,
) -> anyhow::Result<Option<(User, Option<String>)>> {
    let mut tx = pool.begin().await.context("begin auth-lookup tx")?;
    sqlx::query("SELECT set_config('app.auth_email', $1, true)")
        .bind(email)
        .execute(&mut *tx)
        .await
        .context("setting app.auth_email")?;
    #[derive(sqlx::FromRow)]
    struct AuthRow {
        id: Uuid,
        tenant_id: Uuid,
        email: String,
        name: Option<String>,
        role: String,
        locale: String,
        created_at: DateTime<Utc>,
        password_hash: Option<String>,
    }

    let row: Option<AuthRow> = sqlx::query_as(
        "SELECT id, tenant_id, email, name, role, locale, created_at, password_hash \
         FROM users WHERE email = $1 AND password_hash IS NOT NULL",
    )
    .bind(email)
    .fetch_optional(&mut *tx)
    .await
    .context("auth lookup by email")?;
    tx.commit().await?;

    Ok(row.map(|row| {
        (
            User {
                id: row.id,
                tenant_id: row.tenant_id,
                email: row.email,
                name: row.name,
                role: row.role,
                locale: row.locale,
                created_at: row.created_at,
            },
            row.password_hash,
        )
    }))
}

/// Fetch a tenant by id (`tenants` is the tenancy root — no RLS).
pub async fn get_tenant(pool: &PgPool, id: Uuid) -> anyhow::Result<Option<Tenant>> {
    let tenant: Option<Tenant> =
        sqlx::query_as("SELECT id, kind, name, plan, created_at FROM tenants WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await
            .context("get tenant")?;
    Ok(tenant)
}

/// Fetch a user by id inside a tenant-scoped transaction.
pub async fn get_user(
    pool: &PgPool,
    tenant_id: Uuid,
    user_id: Uuid,
) -> anyhow::Result<Option<User>> {
    let mut tx = pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    let user: Option<User> = sqlx::query_as(
        "SELECT id, tenant_id, email, name, role, locale, created_at \
         FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await
    .context("get user")?;
    tx.commit().await?;
    Ok(user)
}

/// The four app roles, highest privilege last. Mirrors Node `APP_ROLES` +
/// the auth-guard RANK table.
pub const APP_ROLES: [&str; 4] = ["viewer", "editor", "admin", "owner"];

/// Roles an admin may hand out via invitation/role-change (owner is excluded —
/// there is exactly one owner, the tenant creator).
pub const INVITABLE_ROLES: [&str; 3] = ["admin", "editor", "viewer"];

/// Normalize an arbitrary role string to one of the four app roles, defaulting
/// to `viewer` (ports Node `normalizeAppRole`: first CSV segment, lowercased).
pub fn normalize_role(role: &str) -> &'static str {
    let first = role
        .split(',')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match first.as_str() {
        "owner" => "owner",
        "admin" => "admin",
        "editor" => "editor",
        _ => "viewer",
    }
}

/// Numeric rank for role comparisons (viewer=0 … owner=3).
pub fn role_rank(role: &str) -> u8 {
    match normalize_role(role) {
        "owner" => 3,
        "admin" => 2,
        "editor" => 1,
        _ => 0,
    }
}

/// Platform role for a user (`user` | `super_admin`) — gates cross-tenant
/// operator endpoints. Looked up per request (rare, low-traffic paths).
pub async fn get_platform_role(
    pool: &PgPool,
    tenant_id: Uuid,
    user_id: Uuid,
) -> anyhow::Result<Option<String>> {
    let mut tx = pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    let row: Option<(String,)> = sqlx::query_as("SELECT platform_role FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await
        .context("get platform_role")?;
    tx.commit().await?;
    Ok(row.map(|r| r.0))
}

/// A user row enriched for the admin directory (`GET /api/users`).
#[derive(Debug, Clone)]
pub struct DirectoryUser {
    pub id: Uuid,
    pub name: Option<String>,
    pub email: String,
    pub role: String,
    pub status: String,
    pub has_login: bool,
    pub created_at: DateTime<Utc>,
    pub last_active: Option<DateTime<Utc>>,
}

/// List every user in a tenant, newest-session-first activity attached.
pub async fn list_directory(pool: &PgPool, tenant_id: Uuid) -> anyhow::Result<Vec<DirectoryUser>> {
    let mut tx = pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    #[derive(sqlx::FromRow)]
    struct Row {
        id: Uuid,
        name: Option<String>,
        email: String,
        role: String,
        status: String,
        has_login: bool,
        created_at: DateTime<Utc>,
        last_active: Option<DateTime<Utc>>,
    }
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT u.id, u.name, u.email, u.role, u.status, \
                (u.password_hash IS NOT NULL) AS has_login, u.created_at, \
                (SELECT max(last_seen_at) FROM auth_sessions s \
                   WHERE s.user_id = u.id AND s.revoked_at IS NULL) AS last_active \
         FROM users u ORDER BY u.name NULLS LAST, u.email",
    )
    .fetch_all(&mut *tx)
    .await
    .context("list directory")?;
    tx.commit().await?;
    Ok(rows
        .into_iter()
        .map(|r| DirectoryUser {
            id: r.id,
            name: r.name,
            email: r.email,
            role: normalize_role(&r.role).to_string(),
            status: r.status,
            has_login: r.has_login,
            created_at: r.created_at,
            last_active: r.last_active,
        })
        .collect())
}

/// A pending org invitation.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Invitation {
    pub id: Uuid,
    pub email: String,
    pub role: String,
    pub status: String,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

/// List a tenant's pending invitations, newest first.
pub async fn list_invitations(pool: &PgPool, tenant_id: Uuid) -> anyhow::Result<Vec<Invitation>> {
    let mut tx = pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    let rows: Vec<Invitation> = sqlx::query_as(
        "SELECT id, email, role, status, expires_at, created_at \
         FROM invitations WHERE status = 'pending' ORDER BY created_at DESC",
    )
    .fetch_all(&mut *tx)
    .await
    .context("list invitations")?;
    tx.commit().await?;
    Ok(rows)
}

/// Create (or refresh) a pending invitation for `email` in a tenant.
pub async fn create_invitation(
    pool: &PgPool,
    tenant_id: Uuid,
    email: &str,
    role: &str,
    invited_by: Uuid,
    ttl_secs: i64,
) -> anyhow::Result<Invitation> {
    let email = email.trim().to_lowercase();
    let role = normalize_role(role);
    let role = if INVITABLE_ROLES.contains(&role) {
        role
    } else {
        "viewer"
    };
    let expires_at = Utc::now() + chrono::Duration::seconds(ttl_secs);

    let mut tx = pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    // Refresh an existing pending invite (role + expiry) or insert a new one.
    let inv: Invitation = sqlx::query_as(
        "INSERT INTO invitations (tenant_id, email, role, invited_by, expires_at) \
         VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT (tenant_id, lower(email)) WHERE status = 'pending' \
           DO UPDATE SET role = $3, expires_at = $5, invited_by = $4 \
         RETURNING id, email, role, status, expires_at, created_at",
    )
    .bind(tenant_id)
    .bind(&email)
    .bind(role)
    .bind(invited_by)
    .bind(expires_at)
    .fetch_one(&mut *tx)
    .await
    .context("create invitation")?;
    tx.commit().await?;
    Ok(inv)
}

/// Cancel a pending invitation; `true` when one was cancelled.
pub async fn cancel_invitation(
    pool: &PgPool,
    tenant_id: Uuid,
    invitation_id: Uuid,
) -> anyhow::Result<bool> {
    let mut tx = pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    let done = sqlx::query(
        "UPDATE invitations SET status = 'canceled' \
         WHERE id = $1 AND status = 'pending'",
    )
    .bind(invitation_id)
    .execute(&mut *tx)
    .await
    .context("cancel invitation")?
    .rows_affected();
    tx.commit().await?;
    Ok(done > 0)
}

/// Sign up, honoring a pending invitation. If a pending invite exists for the
/// email, the user JOINS that inviting tenant with the invited role (and the
/// invite is marked accepted); otherwise a personal tenant is created (the
/// original [`sign_up`] behavior). Email-keyed & tokenless, matching the
/// frontend contract.
pub async fn sign_up_with_invite(
    pool: &PgPool,
    email: &str,
    password: &str,
    name: &str,
) -> Result<AuthedIdentity, SignUpError> {
    let email = email.trim().to_lowercase();
    let password_hash = hash_password(password)?;

    let mut tx = pool.begin().await.context("begin invite sign-up tx")?;
    // Declare the email so the invite_email_lookup policy exposes its pending
    // invitations (no tenant context exists yet).
    sqlx::query("SELECT set_config('app.invite_email', $1, true)")
        .bind(&email)
        .execute(&mut *tx)
        .await
        .context("set app.invite_email")?;
    let invite: Option<(Uuid, Uuid, String)> = sqlx::query_as(
        "SELECT id, tenant_id, role FROM invitations \
         WHERE status = 'pending' AND email = $1 AND expires_at > now() \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&email)
    .fetch_optional(&mut *tx)
    .await
    .context("lookup pending invitation")?;

    let Some((invite_id, tenant_id, role)) = invite else {
        // No invite: fall back to the personal-tenant path. Roll back this tx
        // (only a GUC was set) and delegate.
        tx.rollback().await.ok();
        return sign_up(pool, &email, password, name).await;
    };

    let role = normalize_role(&role);
    set_tenant(&mut tx, tenant_id).await?;
    let inserted = sqlx::query_as::<_, User>(
        "INSERT INTO users (tenant_id, email, name, role, password_hash) \
         VALUES ($1, $2, $3, $4, $5) \
         RETURNING id, tenant_id, email, name, role, locale, created_at",
    )
    .bind(tenant_id)
    .bind(&email)
    .bind(name)
    .bind(role)
    .bind(&password_hash)
    .fetch_one(&mut *tx)
    .await;

    let user = match inserted {
        Ok(user) => user,
        Err(sqlx::Error::Database(db)) if db.is_unique_violation() => {
            return Err(SignUpError::EmailTaken);
        }
        Err(e) => return Err(anyhow::Error::from(e).context("insert invited user").into()),
    };
    sqlx::query("UPDATE invitations SET status = 'accepted', accepted_at = now() WHERE id = $1")
        .bind(invite_id)
        .execute(&mut *tx)
        .await
        .context("mark invitation accepted")?;

    let tenant = sqlx::query_as::<_, Tenant>(
        "SELECT id, kind, name, plan, created_at FROM tenants WHERE id = $1",
    )
    .bind(tenant_id)
    .fetch_one(&mut *tx)
    .await
    .context("load inviting tenant")?;
    tx.commit().await.context("commit invite sign-up")?;
    Ok(AuthedIdentity { user, tenant })
}

/// Update a user's role and/or status (admin action). Returns the effective
/// `(role, status)` after the update, or `None` if the user does not exist.
pub async fn update_user(
    pool: &PgPool,
    tenant_id: Uuid,
    user_id: Uuid,
    role: Option<&str>,
    status: Option<&str>,
) -> anyhow::Result<Option<(String, String)>> {
    let mut tx = pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    if let Some(role) = role {
        sqlx::query("UPDATE users SET role = $2 WHERE id = $1")
            .bind(user_id)
            .bind(normalize_role(role))
            .execute(&mut *tx)
            .await
            .context("update user role")?;
    }
    if let Some(status) = status {
        sqlx::query("UPDATE users SET status = $2 WHERE id = $1")
            .bind(user_id)
            .bind(status)
            .execute(&mut *tx)
            .await
            .context("update user status")?;
    }
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT role, status FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(&mut *tx)
            .await
            .context("read back user")?;
    tx.commit().await?;
    Ok(row)
}

/// Replace a user's password hash (admin-initiated reset). Returns `true` when
/// a row was updated.
pub async fn set_user_password(
    pool: &PgPool,
    tenant_id: Uuid,
    user_id: Uuid,
    new_password: &str,
) -> anyhow::Result<bool> {
    let hash = hash_password(new_password)?;
    let mut tx = pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    let done = sqlx::query("UPDATE users SET password_hash = $2 WHERE id = $1")
        .bind(user_id)
        .bind(&hash)
        .execute(&mut *tx)
        .await
        .context("set user password")?
        .rows_affected();
    tx.commit().await?;
    Ok(done > 0)
}

// ---------------------------------------------------------------------------
// Persistent auth sessions (the durable "devices" list + admin revocation).
// The Redis refresh allowlist stays the per-request check; these rows are the
// listing/audit view. The route layer coordinates DB + Redis.
// ---------------------------------------------------------------------------

/// A persisted session row for the settings "devices" list.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SessionRecord {
    pub id: Uuid,
    pub current_jti: Uuid,
    pub user_agent: Option<String>,
    pub ip_address: Option<String>,
    pub created_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

/// Insert a new session at sign-in.
#[allow(clippy::too_many_arguments)]
pub async fn insert_session(
    pool: &PgPool,
    tenant_id: Uuid,
    sid: Uuid,
    user_id: Uuid,
    current_jti: Uuid,
    user_agent: Option<&str>,
    ip_address: Option<&str>,
    expires_at: DateTime<Utc>,
) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    sqlx::query(
        "INSERT INTO auth_sessions \
           (id, tenant_id, user_id, current_jti, user_agent, ip_address, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(sid)
    .bind(tenant_id)
    .bind(user_id)
    .bind(current_jti)
    .bind(user_agent)
    .bind(ip_address)
    .bind(expires_at)
    .execute(&mut *tx)
    .await
    .context("insert auth_session")?;
    tx.commit().await?;
    Ok(())
}

/// On refresh: rotate the stored current_jti + bump last_seen. Returns `true`
/// when the session still exists and is not revoked.
pub async fn touch_session(
    pool: &PgPool,
    tenant_id: Uuid,
    sid: Uuid,
    new_jti: Uuid,
) -> anyhow::Result<bool> {
    let mut tx = pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    let done = sqlx::query(
        "UPDATE auth_sessions SET current_jti = $2, last_seen_at = now() \
         WHERE id = $1 AND revoked_at IS NULL",
    )
    .bind(sid)
    .bind(new_jti)
    .execute(&mut *tx)
    .await
    .context("touch auth_session")?
    .rows_affected();
    tx.commit().await?;
    Ok(done > 0)
}

/// List a user's live (non-revoked, unexpired) sessions.
pub async fn list_sessions(
    pool: &PgPool,
    tenant_id: Uuid,
    user_id: Uuid,
) -> anyhow::Result<Vec<SessionRecord>> {
    let mut tx = pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    let rows: Vec<SessionRecord> = sqlx::query_as(
        "SELECT id, current_jti, user_agent, ip_address, created_at, last_seen_at, expires_at \
         FROM auth_sessions \
         WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() \
         ORDER BY last_seen_at DESC",
    )
    .bind(user_id)
    .fetch_all(&mut *tx)
    .await
    .context("list auth_sessions")?;
    tx.commit().await?;
    Ok(rows)
}

/// Revoke a single session by id; returns its current refresh jti (for the
/// caller to drop from the Redis allowlist), or `None` if not found.
pub async fn revoke_session(
    pool: &PgPool,
    tenant_id: Uuid,
    sid: Uuid,
) -> anyhow::Result<Option<Uuid>> {
    let mut tx = pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    let row: Option<(Uuid,)> = sqlx::query_as(
        "UPDATE auth_sessions SET revoked_at = now() \
         WHERE id = $1 AND revoked_at IS NULL RETURNING current_jti",
    )
    .bind(sid)
    .fetch_optional(&mut *tx)
    .await
    .context("revoke auth_session")?;
    tx.commit().await?;
    Ok(row.map(|r| r.0))
}

/// Revoke all of a user's sessions except `keep` (may be `None` to revoke all).
/// Returns the refresh jtis that were revoked.
pub async fn revoke_other_sessions(
    pool: &PgPool,
    tenant_id: Uuid,
    user_id: Uuid,
    keep: Option<Uuid>,
) -> anyhow::Result<Vec<Uuid>> {
    let mut tx = pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    let rows: Vec<(Uuid,)> = sqlx::query_as(
        "UPDATE auth_sessions SET revoked_at = now() \
         WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2) \
         RETURNING current_jti",
    )
    .bind(user_id)
    .bind(keep)
    .fetch_all(&mut *tx)
    .await
    .context("revoke other auth_sessions")?;
    tx.commit().await?;
    Ok(rows.into_iter().map(|r| r.0).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_role_maps_to_app_roles() {
        assert_eq!(normalize_role("owner"), "owner");
        assert_eq!(normalize_role("Admin"), "admin");
        assert_eq!(normalize_role("member"), "viewer");
        assert_eq!(normalize_role("editor,extra"), "editor");
        assert_eq!(normalize_role(""), "viewer");
        assert_eq!(role_rank("owner"), 3);
        assert!(role_rank("admin") > role_rank("editor"));
    }

    #[test]
    fn password_roundtrip() {
        let hash = hash_password("correct horse battery staple").unwrap();
        assert!(verify_password("correct horse battery staple", &hash).unwrap());
        assert!(!verify_password("wrong", &hash).unwrap());
    }
}
