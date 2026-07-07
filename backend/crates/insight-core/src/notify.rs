//! In-app notifications (Phase 12): insert a tenant-scoped notification row.
//! (Email/push fanout respecting per-user prefs is a later refinement.)

use anyhow::Context;
use uuid::Uuid;

use crate::storage::{set_tenant, Stores};

/// Create a notification for a tenant.
pub async fn notify(
    stores: &Stores,
    tenant_id: Uuid,
    kind: &str,
    title: &str,
    description: &str,
    action: Option<&str>,
) -> anyhow::Result<()> {
    let kind = match kind {
        "ssot_merge" | "conflict" | "novelty" | "alert" => kind,
        _ => "alert",
    };
    let mut tx = stores.pool.begin().await?;
    set_tenant(&mut tx, tenant_id).await?;
    sqlx::query(
        "INSERT INTO notifications (tenant_id, kind, title, description, action) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(tenant_id)
    .bind(kind)
    .bind(title)
    .bind(description)
    .bind(action)
    .execute(&mut *tx)
    .await
    .context("insert notification")?;
    tx.commit().await?;
    Ok(())
}
