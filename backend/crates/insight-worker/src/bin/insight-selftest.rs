//! insight-selftest — verifies the live storage stack (Postgres+RLS,
//! pgvector, MinIO, Redis) from inside the compose network. Prints one
//! `PASS`/`FAIL` line per check and exits non-zero on any failure.
//! Configuration comes from the environment (DATABASE_URL, REDIS_URL,
//! S3_ENDPOINT_INTERNAL/PUBLIC, MINIO_ROOT_USER/PASSWORD, ...).

#[tokio::main]
async fn main() {
    match insight_core::storage::selftest::run_all().await {
        Ok(0) => {
            println!("selftest: all checks passed");
        }
        Ok(failures) => {
            println!("selftest: {failures} check(s) failed");
            std::process::exit(1);
        }
        Err(e) => {
            println!("FAIL selftest: {e:#}");
            std::process::exit(1);
        }
    }
}
