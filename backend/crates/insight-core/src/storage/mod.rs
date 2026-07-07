//! Storage layer (Phase 2): `DocStore`, `VectorStore`, `GraphStore`, `Cache`
//! over Postgres(+pgvector)/Redis, and `BlobStore` over MinIO via aws-sdk-s3
//! (path-style, presigned PUT/GET against the public endpoint).
//!
//! Tenant isolation is enforced by Postgres row-level security: every store
//! method opens a transaction and calls [`set_tenant`] before touching
//! tenant-scoped tables.

pub mod blob_store;
pub mod cache;
pub mod doc_store;
pub mod graph_store;
pub mod queue;
pub mod selftest;
pub mod vector_store;

use anyhow::Context;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

pub use blob_store::{BlobStore, S3BlobStore};
pub use cache::{Cache, RedisCache};
pub use doc_store::{DocStore, DocumentRow, NewBlock, NewDocument, NewPage, NewUser, PgDocStore};
pub use graph_store::{GraphStore, NewNode, NodeRow, PgGraphStore};
pub use queue::{JobQueue, QueuedJob, JOB_STREAM};
pub use vector_store::{ChunkFilter, ChunkHit, NewChunk, PgVectorStore, VectorStore};

/// Embedded migrations from `crates/insight-core/migrations`.
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!();

/// Advisory lock key guarding concurrent migration runs (api and workers may
/// boot at the same time). Arbitrary but stable project-wide constant.
const MIGRATION_LOCK_KEY: i64 = 0x0049_6e73_6967_6874; // "Insight"

/// Bucket names for the MinIO object store.
#[derive(Debug, Clone)]
pub struct Buckets {
    pub documents: String,
    pub figures: String,
    pub thumbs: String,
    pub audio: String,
    pub exports: String,
}

/// Storage configuration, read from the environment (see `.env.example`).
///
/// `Debug` is implemented manually so that secrets (the database URL, which
/// embeds a password, and the S3 credentials) can never leak into logs via
/// `{:?}` / `tracing::debug!(?config)`.
#[derive(Clone)]
pub struct StorageConfig {
    pub database_url: String,
    pub redis_url: String,
    /// Endpoint the services use for S3 API calls (docker network).
    pub s3_endpoint_internal: String,
    /// Endpoint browsers hit; presigned URLs are minted against this host.
    pub s3_endpoint_public: String,
    pub s3_region: String,
    pub s3_access_key: String,
    pub s3_secret_key: String,
    pub buckets: Buckets,
}

impl std::fmt::Debug for StorageConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StorageConfig")
            .field("database_url", &"***")
            .field("redis_url", &self.redis_url)
            .field("s3_endpoint_internal", &self.s3_endpoint_internal)
            .field("s3_endpoint_public", &self.s3_endpoint_public)
            .field("s3_region", &self.s3_region)
            .field("s3_access_key", &"***")
            .field("s3_secret_key", &"***")
            .field("buckets", &self.buckets)
            .finish()
    }
}

impl StorageConfig {
    /// Build the config from environment variables. `DATABASE_URL`,
    /// `REDIS_URL`, endpoints and S3 credentials are required; region and
    /// bucket names fall back to the compose defaults. Prefer scoped
    /// `S3_ACCESS_KEY`/`S3_SECRET_KEY` (a MinIO service account limited to
    /// the app buckets) over the root credentials when both are set.
    pub fn from_env() -> anyhow::Result<Self> {
        fn required(key: &str) -> anyhow::Result<String> {
            std::env::var(key).with_context(|| format!("missing required env var {key}"))
        }
        fn or_default(key: &str, default: &str) -> String {
            std::env::var(key).unwrap_or_else(|_| default.to_string())
        }
        fn non_empty(key: &str) -> Option<String> {
            std::env::var(key).ok().filter(|v| !v.is_empty())
        }

        Ok(Self {
            database_url: required("DATABASE_URL")?,
            redis_url: required("REDIS_URL")?,
            s3_endpoint_internal: required("S3_ENDPOINT_INTERNAL")?,
            s3_endpoint_public: required("S3_ENDPOINT_PUBLIC")?,
            s3_region: or_default("S3_REGION", "us-east-1"),
            s3_access_key: match non_empty("S3_ACCESS_KEY") {
                Some(v) => v,
                None => required("MINIO_ROOT_USER")?,
            },
            s3_secret_key: match non_empty("S3_SECRET_KEY") {
                Some(v) => v,
                None => required("MINIO_ROOT_PASSWORD")?,
            },
            buckets: Buckets {
                documents: or_default("S3_BUCKET_DOCS", "documents"),
                figures: or_default("S3_BUCKET_FIGS", "figures"),
                thumbs: or_default("S3_BUCKET_THUMBS", "thumbs"),
                audio: or_default("S3_BUCKET_AUDIO", "audio"),
                exports: or_default("S3_BUCKET_EXPORTS", "exports"),
            },
        })
    }
}

/// Per-backend readiness report; `None` means healthy, `Some(err)` degraded.
#[derive(Debug, Default)]
pub struct HealthReport {
    pub postgres: Option<String>,
    pub redis: Option<String>,
    pub object_store: Option<String>,
}

impl HealthReport {
    pub fn healthy(&self) -> bool {
        self.postgres.is_none() && self.redis.is_none() && self.object_store.is_none()
    }
}

/// Bundle of all storage backends. Holds concrete types (traits exist for
/// testability; native async-fn-in-trait is not dyn-compatible, so callers
/// use these concrete stores or go generic).
#[derive(Clone)]
pub struct Stores {
    pub pool: PgPool,
    pub docs: PgDocStore,
    pub vectors: PgVectorStore,
    pub graph: PgGraphStore,
    pub blobs: S3BlobStore,
    pub cache: RedisCache,
    /// Runtime-tunable settings (system/org/user), with a shared TTL cache so
    /// both the api and the worker read hot-path config cheaply.
    pub settings: crate::settings::SettingsStore,
    pub config: StorageConfig,
}

impl Stores {
    /// Connect to Postgres, Redis, and MinIO. Does not run migrations; call
    /// [`run_migrations`] explicitly at boot.
    pub async fn connect(config: StorageConfig) -> anyhow::Result<Stores> {
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect(&config.database_url)
            .await
            .context("connecting to postgres")?;
        assert_rls_capable_role(&pool)
            .await
            .context("verifying the database role cannot bypass row-level security")?;
        let cache = RedisCache::connect(&config.redis_url)
            .await
            .context("connecting to redis")?;
        let blobs = S3BlobStore::new(&config);

        Ok(Stores {
            docs: PgDocStore::new(pool.clone()),
            vectors: PgVectorStore::new(pool.clone()),
            graph: PgGraphStore::new(pool.clone()),
            blobs,
            cache,
            settings: crate::settings::SettingsStore::new(pool.clone()),
            pool,
            config,
        })
    }

    /// Probe Postgres, Redis, and the object store (documents bucket).
    pub async fn health(&self) -> HealthReport {
        let postgres = sqlx::query("SELECT 1")
            .execute(&self.pool)
            .await
            .err()
            .map(|e| e.to_string());
        let redis = self.cache.ping().await.err().map(|e| format!("{e:#}"));
        let object_store = self
            .blobs
            .bucket_exists(&self.config.buckets.documents)
            .await
            .err()
            .map(|e| format!("{e:#}"));
        HealthReport {
            postgres,
            redis,
            object_store,
        }
    }
}

/// Fail fast when the connected role would silently bypass row-level
/// security. SUPERUSER (and BYPASSRLS) roles ignore RLS entirely — even with
/// `FORCE ROW LEVEL SECURITY` — which would disable tenant isolation without
/// any visible error. The compose stack provisions a dedicated non-superuser
/// app role (`deploy/postgres-init/01-app-role.sh`); this guard makes the
/// misconfiguration (e.g. pointing DATABASE_URL at the bootstrap superuser)
/// impossible to miss. Set `INSIGHT_ALLOW_SUPERUSER=1` to override for
/// throwaway local experiments ONLY.
pub async fn assert_rls_capable_role(pool: &PgPool) -> anyhow::Result<()> {
    let (rolname, rolsuper, rolbypassrls): (String, bool, bool) = sqlx::query_as(
        "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    )
    .fetch_one(pool)
    .await
    .context("querying pg_roles for the current user")?;

    if rolsuper || rolbypassrls {
        if std::env::var("INSIGHT_ALLOW_SUPERUSER").as_deref() == Ok("1") {
            tracing::warn!(
                role = %rolname,
                "connected as a SUPERUSER/BYPASSRLS role — row-level security is \
                 INACTIVE; tenant isolation is NOT enforced (INSIGHT_ALLOW_SUPERUSER=1)"
            );
            return Ok(());
        }
        anyhow::bail!(
            "database role '{rolname}' is {} — it bypasses row-level security, so tenant \
             isolation would be silently disabled. Point DATABASE_URL at the non-superuser \
             app role (see deploy/postgres-init/01-app-role.sh), or set \
             INSIGHT_ALLOW_SUPERUSER=1 for throwaway local use only",
            if rolsuper { "SUPERUSER" } else { "BYPASSRLS" }
        );
    }
    Ok(())
}

/// Run embedded migrations, serialized by a Postgres advisory lock so that
/// api + N workers booting simultaneously do not race.
pub async fn run_migrations(pool: &PgPool) -> anyhow::Result<()> {
    let mut conn = pool
        .acquire()
        .await
        .context("acquiring connection for migrations")?;
    sqlx::query("SELECT pg_advisory_lock($1)")
        .bind(MIGRATION_LOCK_KEY)
        .execute(&mut *conn)
        .await
        .context("taking migration advisory lock")?;

    let result = MIGRATOR.run(&mut *conn).await;

    // Best-effort unlock; the lock also dies with the session.
    let _ = sqlx::query("SELECT pg_advisory_unlock($1)")
        .bind(MIGRATION_LOCK_KEY)
        .execute(&mut *conn)
        .await;

    result.context("applying sqlx migrations")?;
    Ok(())
}

/// Set the RLS tenant context for the current transaction.
///
/// `SET LOCAL` cannot take bind parameters, so this uses
/// `set_config('app.tenant', $1, true)` — identical transaction-local
/// semantics, but with a proper bind instead of string interpolation.
pub async fn set_tenant(tx: &mut Transaction<'_, Postgres>, tenant_id: Uuid) -> anyhow::Result<()> {
    sqlx::query("SELECT set_config('app.tenant', $1, true)")
        .bind(tenant_id.to_string())
        .execute(&mut **tx)
        .await
        .context("setting app.tenant for transaction")?;
    Ok(())
}
