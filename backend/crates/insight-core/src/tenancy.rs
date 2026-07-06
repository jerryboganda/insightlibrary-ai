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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_roundtrip() {
        let hash = hash_password("correct horse battery staple").unwrap();
        assert!(verify_password("correct horse battery staple", &hash).unwrap());
        assert!(!verify_password("wrong", &hash).unwrap());
    }
}
