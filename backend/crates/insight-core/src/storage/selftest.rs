//! Live-environment storage selftest, run by the `insight-selftest` binary
//! inside the compose network. Prints one `PASS <name>` / `FAIL <name>: <err>`
//! line per check and returns the failure count; created rows/objects are
//! cleaned up best-effort at the end.
//!
//! RLS note: the isolation checks are only meaningful when connected as a
//! NON-superuser. SUPERUSER (and BYPASSRLS) roles ignore RLS entirely, even
//! with `FORCE ROW LEVEL SECURITY` — FORCE only binds non-superuser table
//! owners. The compose stack therefore connects as the dedicated
//! non-superuser app role created by `deploy/postgres-init/01-app-role.sh`
//! (which owns the database, so FORCE applies to it), and this selftest
//! FAILs outright if the connected role is SUPERUSER or BYPASSRLS.

use std::time::Duration;

use anyhow::Context;
use uuid::Uuid;

use super::{
    run_migrations, set_tenant, BlobStore, Cache, ChunkFilter, DocStore, GraphStore, NewChunk,
    NewDocument, NewNode, NewUser, StorageConfig, Stores, VectorStore,
};
use crate::storage::vector_store::CHUNK_DIM;

/// Rows/objects created by the selftest, removed best-effort afterwards.
#[derive(Debug, Default)]
struct Cleanup {
    tenants: Vec<Uuid>,
    objects: Vec<(String, String)>,
    cache_keys: Vec<String>,
}

fn report(name: &str, result: anyhow::Result<()>, failures: &mut u32) {
    match result {
        Ok(()) => println!("PASS {name}"),
        Err(e) => {
            println!("FAIL {name}: {e:#}");
            *failures += 1;
        }
    }
}

/// Run every check against the live environment (config from env vars).
/// Returns the number of failed checks.
pub async fn run_all() -> anyhow::Result<u32> {
    let cfg = StorageConfig::from_env().context("reading storage config from env")?;
    let stores = Stores::connect(cfg.clone())
        .await
        .context("connecting to storage backends")?;

    let mut failures = 0u32;
    let mut cleanup = Cleanup::default();

    if let Err(e) = run_checks(&stores, &cfg, &mut cleanup, &mut failures).await {
        // A hard prerequisite failed; dependent checks were skipped.
        println!("FAIL aborted: {e:#}");
        failures += 1;
    }

    run_cleanup(&stores, &cleanup).await;
    Ok(failures)
}

async fn run_checks(
    stores: &Stores,
    cfg: &StorageConfig,
    cleanup: &mut Cleanup,
    failures: &mut u32,
) -> anyhow::Result<()> {
    // a. migrations applied and idempotent (Stores::connect already found the
    //    schema if the api ran first; running again must be a no-op).
    report(
        "migrations_idempotent",
        run_migrations(&stores.pool).await,
        failures,
    );

    // a2. the connected role must not be able to bypass RLS. SUPERUSER and
    //     BYPASSRLS roles ignore row-level security even with FORCE ROW
    //     LEVEL SECURITY, which would make every isolation check below
    //     meaningless (and production leak cross-tenant data).
    let superuser_check = async {
        let (rolname, rolsuper, rolbypassrls): (String, bool, bool) = sqlx::query_as(
            "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        )
        .fetch_one(&stores.pool)
        .await?;
        anyhow::ensure!(
            !rolsuper && !rolbypassrls,
            "connected role '{rolname}' is {} — RLS tenant isolation is INACTIVE; connect as \
             the non-superuser app role (deploy/postgres-init/01-app-role.sh)",
            if rolsuper { "SUPERUSER" } else { "BYPASSRLS" }
        );
        Ok(())
    }
    .await;
    report("db_user_not_superuser", superuser_check, failures);

    // a3. structural RLS coverage: EVERY table with a tenant_id column must
    //     have RLS enabled AND forced AND at least one policy. This catches
    //     a future migration adding a tenant table without a policy — the
    //     per-table probes below only exercise documents/chunks.
    let coverage_check = async {
        let offenders: Vec<String> = sqlx::query_scalar(
            "SELECT c.relname::text \
             FROM pg_class c \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = 'public' \
               AND c.relkind = 'r' \
               AND EXISTS (SELECT 1 FROM pg_attribute a \
                           WHERE a.attrelid = c.oid \
                             AND a.attname = 'tenant_id' \
                             AND NOT a.attisdropped) \
               AND NOT (c.relrowsecurity \
                        AND c.relforcerowsecurity \
                        AND EXISTS (SELECT 1 FROM pg_policies p \
                                    WHERE p.schemaname = 'public' \
                                      AND p.tablename = c.relname)) \
             ORDER BY 1",
        )
        .fetch_all(&stores.pool)
        .await?;
        anyhow::ensure!(
            offenders.is_empty(),
            "tables with tenant_id lacking ENABLE+FORCE RLS or a policy: {}",
            offenders.join(", ")
        );
        Ok(())
    }
    .await;
    report("rls_coverage_catalog", coverage_check, failures);

    // b. two tenants + a user each (hard prerequisite for everything below).
    let tenant_a = stores
        .docs
        .create_tenant("user", "selftest-tenant-a", "free")
        .await
        .context("create tenant A")?;
    cleanup.tenants.push(tenant_a);
    let tenant_b = stores
        .docs
        .create_tenant("org", "selftest-tenant-b", "free")
        .await
        .context("create tenant B")?;
    cleanup.tenants.push(tenant_b);

    let run_id = Uuid::new_v4();
    let user = |suffix: &str| NewUser {
        email: format!("selftest-{run_id}-{suffix}@example.invalid"),
        name: Some(format!("Selftest {suffix}")),
        role: "member".to_string(),
        locale: "en".to_string(),
    };
    stores
        .docs
        .create_user(tenant_a, &user("a"))
        .await
        .context("create user in tenant A")?;
    stores
        .docs
        .create_user(tenant_b, &user("b"))
        .await
        .context("create user in tenant B")?;
    println!("PASS create_tenants_and_users");

    // c. document row for A + object bytes round-trip through MinIO.
    let bucket = cfg.buckets.documents.clone();
    let key = format!("selftest/{run_id}.bin");
    let payload = b"insight-library storage selftest payload".to_vec();

    let doc = NewDocument {
        storage_key: key.clone(),
        sha256: "selftest-sha256".to_string(),
        title: "Selftest Document A".to_string(),
        source_type: "selftest".to_string(),
        source_ref: None,
        license: None,
        owner: None,
        course: None,
        subject: None,
        folder_id: None,
    };
    let doc_a = stores
        .docs
        .insert_document(tenant_a, &doc)
        .await
        .context("insert document for A")?;

    let blob_check = async {
        stores
            .blobs
            .put_object(&bucket, &key, payload.clone())
            .await?;
        cleanup.objects.push((bucket.clone(), key.clone()));
        let fetched = stores.blobs.get_object(&bucket, &key).await?;
        anyhow::ensure!(fetched == payload, "MinIO round-trip bytes differ");
        let row = stores
            .docs
            .get_document(tenant_a, doc_a)
            .await?
            .context("document row not found after insert")?;
        anyhow::ensure!(row.storage_key == key, "stored storage_key mismatch");
        Ok(())
    }
    .await;
    report("document_and_blob_roundtrip", blob_check, failures);

    // d. presigned GET must point browsers at the PUBLIC host: the URL's
    //    authority must EQUAL the public endpoint host (not merely contain
    //    it) and carry SigV4 query parameters. (The public host usually does
    //    not resolve from inside the compose network, so an end-to-end GET
    //    against the presigned URL is not possible here; signature validity
    //    against MINIO_SERVER_URL is covered by manual/browser testing.)
    let presign_check = async {
        let url = stores
            .blobs
            .presign_get(&bucket, &key, Duration::from_secs(300))
            .await?;
        let public = cfg.s3_endpoint_public.trim_end_matches('/');
        let public_host = public
            .split_once("://")
            .map(|(_, rest)| rest)
            .unwrap_or(public)
            .split('/')
            .next()
            .unwrap_or_default();
        let url_host = url
            .split_once("://")
            .map(|(_, rest)| rest)
            .context("presigned URL has no scheme")?
            .split(['/', '?'])
            .next()
            .unwrap_or_default();
        anyhow::ensure!(
            url_host == public_host,
            "presigned URL host {url_host} != public endpoint host {public_host} (url: {url})"
        );
        anyhow::ensure!(
            url.contains("X-Amz-Signature=") && url.contains("X-Amz-Credential="),
            "presigned URL {url} is missing SigV4 query parameters"
        );
        Ok(())
    }
    .await;
    report("presign_get_uses_public_host", presign_check, failures);

    // e. 768-dim chunk insert + KNN finds it for tenant A.
    let mut vec_a = vec![0.0f32; CHUNK_DIM];
    for (i, v) in vec_a.iter_mut().enumerate() {
        *v = ((i as f32) * 0.01).sin();
    }
    let chunk = NewChunk {
        id: None,
        vector: vec_a.clone(),
        text: "selftest chunk for tenant A".to_string(),
        contextual_prefix: None,
        block_id: None,
        topic: Some("selftest".to_string()),
        system_tags: None,
        source_type: Some("selftest".to_string()),
        date: None,
    };
    let mut chunk_a = None;
    let knn_check = async {
        let ids = stores.vectors.upsert_chunks(tenant_a, &[chunk]).await?;
        let id = *ids.first().context("no chunk id returned")?;
        chunk_a = Some(id);
        let filter = ChunkFilter {
            source_type: Some("selftest".to_string()),
            topic: None,
        };
        let hits = stores
            .vectors
            .knn_search(tenant_a, &vec_a, 5, Some(&filter))
            .await?;
        anyhow::ensure!(
            hits.iter().any(|h| h.id == id),
            "knn_search did not return the inserted chunk"
        );
        Ok(())
    }
    .await;
    report("chunk_upsert_and_knn", knn_check, failures);

    // f. RLS isolation, both directions. Also give B a document so the
    //    "A cannot see B" direction is a real check.
    let doc_b = stores
        .docs
        .insert_document(
            tenant_b,
            &NewDocument {
                storage_key: format!("selftest/{run_id}-b.bin"),
                sha256: "selftest-sha256-b".to_string(),
                title: "Selftest Document B".to_string(),
                source_type: "selftest".to_string(),
                source_ref: None,
                license: None,
                owner: None,
                course: None,
                subject: None,
                folder_id: None,
            },
        )
        .await
        .context("insert document for B")?;

    let rls_check = async {
        // With tenant B set, A's rows must be invisible.
        let mut tx = stores.pool.begin().await?;
        set_tenant(&mut tx, tenant_b).await?;
        let docs_visible: i64 = sqlx::query_scalar("SELECT count(*) FROM documents WHERE id = $1")
            .bind(doc_a)
            .fetch_one(&mut *tx)
            .await?;
        let chunks_visible: i64 = match chunk_a {
            Some(id) => {
                sqlx::query_scalar("SELECT count(*) FROM chunks WHERE id = $1")
                    .bind(id)
                    .fetch_one(&mut *tx)
                    .await?
            }
            None => 0,
        };
        tx.commit().await?;
        anyhow::ensure!(docs_visible == 0, "tenant B can see tenant A's document");
        anyhow::ensure!(chunks_visible == 0, "tenant B can see tenant A's chunk");

        // Vice versa: with tenant A set, B's document must be invisible.
        let mut tx = stores.pool.begin().await?;
        set_tenant(&mut tx, tenant_a).await?;
        let b_docs_visible: i64 =
            sqlx::query_scalar("SELECT count(*) FROM documents WHERE id = $1")
                .bind(doc_b)
                .fetch_one(&mut *tx)
                .await?;
        tx.commit().await?;
        anyhow::ensure!(b_docs_visible == 0, "tenant A can see tenant B's document");

        // And a KNN under tenant B must not surface A's chunk.
        let hits = stores.vectors.knn_search(tenant_b, &vec_a, 5, None).await?;
        anyhow::ensure!(
            hits.is_empty(),
            "knn_search under tenant B returned tenant A's chunks"
        );

        // No tenant context at all (GUC unset) must yield ZERO rows on every
        // store's tables — one probe per store (documents/chunks/nodes).
        let mut tx = stores.pool.begin().await?;
        let no_ctx_docs: i64 = sqlx::query_scalar("SELECT count(*) FROM documents")
            .fetch_one(&mut *tx)
            .await?;
        let no_ctx_chunks: i64 = sqlx::query_scalar("SELECT count(*) FROM chunks")
            .fetch_one(&mut *tx)
            .await?;
        let no_ctx_nodes: i64 = sqlx::query_scalar("SELECT count(*) FROM nodes")
            .fetch_one(&mut *tx)
            .await?;
        tx.rollback().await?;
        anyhow::ensure!(
            no_ctx_docs == 0 && no_ctx_chunks == 0 && no_ctx_nodes == 0,
            "queries with NO tenant context returned rows \
             (documents={no_ctx_docs}, chunks={no_ctx_chunks}, nodes={no_ctx_nodes})"
        );

        // Write-path isolation: with tenant B set, UPDATE/DELETE against A's
        // rows must affect 0 rows.
        let mut tx = stores.pool.begin().await?;
        set_tenant(&mut tx, tenant_b).await?;
        let updated = sqlx::query("UPDATE documents SET title = 'hijacked' WHERE id = $1")
            .bind(doc_a)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        let deleted = sqlx::query("DELETE FROM documents WHERE id = $1")
            .bind(doc_a)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        tx.rollback().await?;
        anyhow::ensure!(
            updated == 0,
            "tenant B UPDATEd tenant A's document ({updated} rows)"
        );
        anyhow::ensure!(
            deleted == 0,
            "tenant B DELETEd tenant A's document ({deleted} rows)"
        );
        Ok(())
    }
    .await;
    report("rls_tenant_isolation", rls_check, failures);

    // f2. KNN recall under RLS with a crowded index: the HNSW scan yields the
    //     global top-ef_search candidates and the tenant predicate is a
    //     post-filter, so a small tenant can get zero hits unless iterative
    //     scanning (pgvector >= 0.8) keeps going. Give tenant B a dense crowd
    //     of vectors near the query point and assert tenant A still finds its
    //     own (farther) chunk. (On a tiny table the planner may pick a seq
    //     scan and pass trivially, but this still guards the policy + the
    //     iterative-scan regression on realistic data.)
    let knn_load_check = async {
        let chunk_a = chunk_a.context("chunk A missing (earlier check failed)")?;
        let mut center = vec![0.0f32; CHUNK_DIM];
        for (i, v) in center.iter_mut().enumerate() {
            *v = ((i as f32) * 0.01).cos(); // deliberately far from vec_a
        }
        let crowd: Vec<NewChunk> = (0..120)
            .map(|j| {
                let mut v = center.clone();
                // Tiny per-chunk jitter keeps the crowd tightly packed
                // around the query point without duplicating vectors.
                v[j % CHUNK_DIM] += 0.001 * ((j % 7) as f32 + 1.0);
                NewChunk {
                    id: None,
                    vector: v,
                    text: format!("selftest crowd chunk {j} for tenant B"),
                    contextual_prefix: None,
                    block_id: None,
                    topic: None,
                    system_tags: None,
                    source_type: Some("selftest-crowd".to_string()),
                    date: None,
                }
            })
            .collect();
        stores.vectors.upsert_chunks(tenant_b, &crowd).await?;

        let hits = stores
            .vectors
            .knn_search(tenant_a, &center, 5, None)
            .await?;
        anyhow::ensure!(
            hits.iter().any(|h| h.id == chunk_a),
            "tenant A's chunk was crowded out by tenant B's vectors \
             (HNSW post-filter recall loss; got {} hits)",
            hits.len()
        );
        Ok(())
    }
    .await;
    report("knn_isolation_under_load", knn_load_check, failures);

    // g. graph: node + edge upsert, then neighbors via recursive CTE.
    let graph_check = async {
        let n1 = stores
            .graph
            .upsert_node(
                tenant_a,
                &NewNode {
                    id: None,
                    kind: "concept".to_string(),
                    label: "selftest-node-1".to_string(),
                    canonical_concept_id: None,
                    description: None,
                },
            )
            .await?;
        let n2 = stores
            .graph
            .upsert_node(
                tenant_a,
                &NewNode {
                    id: None,
                    kind: "concept".to_string(),
                    label: "selftest-node-2".to_string(),
                    canonical_concept_id: None,
                    description: Some("neighbor".to_string()),
                },
            )
            .await?;
        stores
            .graph
            .upsert_edge(tenant_a, n1, n2, "related_to", 0.9, None)
            .await?;
        let neighbors = stores.graph.neighbors(tenant_a, n1, 2).await?;
        anyhow::ensure!(
            neighbors.iter().any(|n| n.id == n2),
            "neighbors() did not return the connected node"
        );
        Ok(())
    }
    .await;
    report("graph_upsert_and_neighbors", graph_check, failures);

    // h. cache set/get/del (+incr, publish).
    let cache_key = format!("selftest:{run_id}");
    cleanup.cache_keys.push(cache_key.clone());
    let counter_key = format!("selftest:{run_id}:counter");
    cleanup.cache_keys.push(counter_key.clone());
    let cache_check = async {
        stores.cache.set_with_ttl(&cache_key, "value", 60).await?;
        let got = stores.cache.get(&cache_key).await?;
        anyhow::ensure!(got.as_deref() == Some("value"), "cache get != set value");
        stores.cache.del(&cache_key).await?;
        let gone = stores.cache.get(&cache_key).await?;
        anyhow::ensure!(gone.is_none(), "cache key still present after del");
        let count = stores.cache.incr(&counter_key).await?;
        anyhow::ensure!(count == 1, "incr on fresh key returned {count}");
        stores
            .cache
            .publish("selftest:channel", "selftest payload")
            .await?;
        Ok(())
    }
    .await;
    report("cache_roundtrip", cache_check, failures);

    Ok(())
}

/// Best-effort cleanup. Deleting the tenants cascades to all child rows
/// (referential actions bypass RLS); objects and cache keys go separately.
async fn run_cleanup(stores: &Stores, cleanup: &Cleanup) {
    for tenant in &cleanup.tenants {
        if let Err(e) = sqlx::query("DELETE FROM tenants WHERE id = $1")
            .bind(tenant)
            .execute(&stores.pool)
            .await
        {
            println!("WARN cleanup tenant {tenant}: {e}");
        }
    }
    for (bucket, key) in &cleanup.objects {
        if let Err(e) = stores.blobs.delete_object(bucket, key).await {
            println!("WARN cleanup object {bucket}/{key}: {e:#}");
        }
    }
    for key in &cleanup.cache_keys {
        if let Err(e) = stores.cache.del(key).await {
            println!("WARN cleanup cache key {key}: {e:#}");
        }
    }
}
