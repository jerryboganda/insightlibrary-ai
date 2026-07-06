//! Document store: tenants, users, documents, pages, blocks over Postgres.
//! Every tenant-scoped operation runs in a transaction with the RLS tenant
//! context set via [`super::set_tenant`].

use anyhow::Context;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use super::set_tenant;

/// New user payload (`create_user`).
#[derive(Debug, Clone)]
pub struct NewUser {
    pub email: String,
    pub name: Option<String>,
    pub role: String,
    pub locale: String,
}

/// New document payload (`insert_document`). Bytes go to MinIO first; this
/// records the object key + metadata.
#[derive(Debug, Clone)]
pub struct NewDocument {
    pub storage_key: String,
    pub sha256: String,
    pub title: String,
    pub source_type: String,
    pub source_ref: Option<String>,
    pub license: Option<String>,
    pub owner: Option<String>,
    pub course: Option<String>,
    pub subject: Option<String>,
    /// Frontend folder assignment (opaque client id; folders become a
    /// first-class entity in a later phase).
    pub folder_id: Option<String>,
}

/// New page payload (`insert_pages`).
#[derive(Debug, Clone)]
pub struct NewPage {
    pub page_no: i32,
    pub width: Option<f32>,
    pub height: Option<f32>,
    pub thumb_key: Option<String>,
}

/// New block payload (`insert_blocks`).
#[derive(Debug, Clone)]
pub struct NewBlock {
    pub page_id: Uuid,
    pub kind: String,
    pub bbox: Option<serde_json::Value>,
    pub reading_order: Option<i32>,
    pub text: Option<String>,
    pub table_json: Option<serde_json::Value>,
    pub figure_key: Option<String>,
    pub confidence: Option<f32>,
}

/// Document row as stored.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct DocumentRow {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub storage_key: String,
    pub sha256: String,
    pub title: String,
    pub source_type: String,
    pub source_ref: Option<String>,
    pub license: Option<String>,
    pub owner: Option<String>,
    pub course: Option<String>,
    pub subject: Option<String>,
    pub status: String,
    pub added_at: DateTime<Utc>,
    pub folder_id: Option<String>,
}

const DOCUMENT_COLUMNS: &str = "id, tenant_id, storage_key, sha256, title, source_type, \
     source_ref, license, owner, course, subject, status, added_at, folder_id";

/// Tenant/user/document persistence. Native async-fn-in-trait (not
/// dyn-compatible); use generics or the concrete [`PgDocStore`].
#[allow(async_fn_in_trait)]
pub trait DocStore {
    async fn create_tenant(&self, kind: &str, name: &str, plan: &str) -> anyhow::Result<Uuid>;
    async fn create_user(&self, tenant_id: Uuid, user: &NewUser) -> anyhow::Result<Uuid>;
    async fn insert_document(&self, tenant_id: Uuid, doc: &NewDocument) -> anyhow::Result<Uuid>;
    async fn get_document(&self, tenant_id: Uuid, id: Uuid) -> anyhow::Result<Option<DocumentRow>>;
    /// List documents, newest first. `folder_id = Some(..)` restricts to one
    /// folder; `None` lists all of the tenant's documents.
    async fn list_documents(
        &self,
        tenant_id: Uuid,
        folder_id: Option<&str>,
        limit: i64,
        offset: i64,
    ) -> anyhow::Result<Vec<DocumentRow>>;
    async fn insert_pages(
        &self,
        tenant_id: Uuid,
        document_id: Uuid,
        pages: &[NewPage],
    ) -> anyhow::Result<Vec<Uuid>>;
    async fn insert_blocks(
        &self,
        tenant_id: Uuid,
        blocks: &[NewBlock],
    ) -> anyhow::Result<Vec<Uuid>>;
    async fn update_document_status(
        &self,
        tenant_id: Uuid,
        id: Uuid,
        status: &str,
    ) -> anyhow::Result<()>;
}

/// Postgres-backed [`DocStore`].
#[derive(Clone)]
pub struct PgDocStore {
    pool: PgPool,
}

impl PgDocStore {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

impl DocStore for PgDocStore {
    /// `tenants` is the tenancy root (no RLS), so no tenant context is needed.
    async fn create_tenant(&self, kind: &str, name: &str, plan: &str) -> anyhow::Result<Uuid> {
        let id: Uuid = sqlx::query_scalar(
            "INSERT INTO tenants (kind, name, plan) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(kind)
        .bind(name)
        .bind(plan)
        .fetch_one(&self.pool)
        .await
        .context("insert tenant")?;
        Ok(id)
    }

    async fn create_user(&self, tenant_id: Uuid, user: &NewUser) -> anyhow::Result<Uuid> {
        let mut tx = self.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;
        let id: Uuid = sqlx::query_scalar(
            "INSERT INTO users (tenant_id, email, name, role, locale) \
             VALUES ($1, $2, $3, $4, $5) RETURNING id",
        )
        .bind(tenant_id)
        .bind(&user.email)
        .bind(&user.name)
        .bind(&user.role)
        .bind(&user.locale)
        .fetch_one(&mut *tx)
        .await
        .context("insert user")?;
        tx.commit().await?;
        Ok(id)
    }

    async fn insert_document(&self, tenant_id: Uuid, doc: &NewDocument) -> anyhow::Result<Uuid> {
        let mut tx = self.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;
        let id: Uuid = sqlx::query_scalar(
            "INSERT INTO documents (tenant_id, storage_key, sha256, title, source_type, \
             source_ref, license, owner, course, subject, folder_id) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id",
        )
        .bind(tenant_id)
        .bind(&doc.storage_key)
        .bind(&doc.sha256)
        .bind(&doc.title)
        .bind(&doc.source_type)
        .bind(&doc.source_ref)
        .bind(&doc.license)
        .bind(&doc.owner)
        .bind(&doc.course)
        .bind(&doc.subject)
        .bind(&doc.folder_id)
        .fetch_one(&mut *tx)
        .await
        .context("insert document")?;
        tx.commit().await?;
        Ok(id)
    }

    async fn get_document(&self, tenant_id: Uuid, id: Uuid) -> anyhow::Result<Option<DocumentRow>> {
        let mut tx = self.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;
        let sql = format!("SELECT {DOCUMENT_COLUMNS} FROM documents WHERE id = $1");
        let row: Option<DocumentRow> = sqlx::query_as(&sql)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
            .context("get document")?;
        tx.commit().await?;
        Ok(row)
    }

    async fn list_documents(
        &self,
        tenant_id: Uuid,
        folder_id: Option<&str>,
        limit: i64,
        offset: i64,
    ) -> anyhow::Result<Vec<DocumentRow>> {
        let mut tx = self.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;
        let sql = format!(
            "SELECT {DOCUMENT_COLUMNS} FROM documents \
             WHERE ($1::text IS NULL OR folder_id = $1) \
             ORDER BY added_at DESC LIMIT $2 OFFSET $3"
        );
        let rows: Vec<DocumentRow> = sqlx::query_as(&sql)
            .bind(folder_id)
            .bind(limit)
            .bind(offset)
            .fetch_all(&mut *tx)
            .await
            .context("list documents")?;
        tx.commit().await?;
        Ok(rows)
    }

    async fn insert_pages(
        &self,
        tenant_id: Uuid,
        document_id: Uuid,
        pages: &[NewPage],
    ) -> anyhow::Result<Vec<Uuid>> {
        let mut tx = self.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;
        let mut ids = Vec::with_capacity(pages.len());
        for page in pages {
            let id: Uuid = sqlx::query_scalar(
                "INSERT INTO pages (tenant_id, document_id, page_no, width, height, thumb_key) \
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
            )
            .bind(tenant_id)
            .bind(document_id)
            .bind(page.page_no)
            .bind(page.width)
            .bind(page.height)
            .bind(&page.thumb_key)
            .fetch_one(&mut *tx)
            .await
            .with_context(|| format!("insert page {}", page.page_no))?;
            ids.push(id);
        }
        tx.commit().await?;
        Ok(ids)
    }

    async fn insert_blocks(
        &self,
        tenant_id: Uuid,
        blocks: &[NewBlock],
    ) -> anyhow::Result<Vec<Uuid>> {
        let mut tx = self.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;
        let mut ids = Vec::with_capacity(blocks.len());
        for block in blocks {
            let id: Uuid = sqlx::query_scalar(
                "INSERT INTO blocks (tenant_id, page_id, kind, bbox, reading_order, text, \
                 table_json, figure_key, confidence) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id",
            )
            .bind(tenant_id)
            .bind(block.page_id)
            .bind(&block.kind)
            .bind(&block.bbox)
            .bind(block.reading_order)
            .bind(&block.text)
            .bind(&block.table_json)
            .bind(&block.figure_key)
            .bind(block.confidence)
            .fetch_one(&mut *tx)
            .await
            .context("insert block")?;
            ids.push(id);
        }
        tx.commit().await?;
        Ok(ids)
    }

    async fn update_document_status(
        &self,
        tenant_id: Uuid,
        id: Uuid,
        status: &str,
    ) -> anyhow::Result<()> {
        let mut tx = self.pool.begin().await?;
        set_tenant(&mut tx, tenant_id).await?;
        let result = sqlx::query("UPDATE documents SET status = $2 WHERE id = $1")
            .bind(id)
            .bind(status)
            .execute(&mut *tx)
            .await
            .context("update document status")?;
        tx.commit().await?;
        anyhow::ensure!(
            result.rows_affected() == 1,
            "document {id} not found for tenant {tenant_id}"
        );
        Ok(())
    }
}
