//! Blob store over MinIO via aws-sdk-s3.
//!
//! Two clients: `ops` talks to the internal docker-network endpoint for all
//! server-side operations; `public` exists solely to mint presigned URLs
//! against the public host so browsers can PUT/GET directly through the
//! tunnel (MinIO is started with `MINIO_SERVER_URL` = public host so those
//! signatures validate).

use std::time::Duration;

use anyhow::Context;
use aws_sdk_s3::config::{Credentials, Region};
use aws_sdk_s3::error::SdkError;
use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client;

use super::StorageConfig;

/// Object storage. Native async-fn-in-trait.
///
/// SECURITY: this trait has NO tenant dimension — keys are free-form and
/// `presign_get`/`presign_put` will mint a browser-usable URL for ANY
/// object. Tenant isolation for blobs rests entirely on callers deriving
/// bucket/key values from RLS-protected rows (documents.storage_key,
/// pages.thumb_key, blocks.figure_key, ...). API endpoints must NEVER pass a
/// client-supplied key into these methods. A tenant-prefixed wrapper is
/// planned for the phase that adds user-facing object endpoints.
#[allow(async_fn_in_trait)]
pub trait BlobStore {
    async fn put_object(&self, bucket: &str, key: &str, bytes: Vec<u8>) -> anyhow::Result<()>;
    async fn get_object(&self, bucket: &str, key: &str) -> anyhow::Result<Vec<u8>>;
    async fn delete_object(&self, bucket: &str, key: &str) -> anyhow::Result<()>;
    /// `true` if the object exists.
    async fn head(&self, bucket: &str, key: &str) -> anyhow::Result<bool>;
    /// Presigned upload URL on the PUBLIC endpoint.
    async fn presign_put(&self, bucket: &str, key: &str, ttl: Duration) -> anyhow::Result<String>;
    /// Presigned download URL on the PUBLIC endpoint.
    async fn presign_get(&self, bucket: &str, key: &str, ttl: Duration) -> anyhow::Result<String>;
}

/// MinIO-backed [`BlobStore`] (aws-sdk-s3, path-style addressing).
#[derive(Clone)]
pub struct S3BlobStore {
    /// Internal-endpoint client for all server-side object operations.
    ops: Client,
    /// Public-endpoint client used ONLY to mint presigned URLs.
    public: Client,
}

impl S3BlobStore {
    pub fn new(cfg: &StorageConfig) -> Self {
        let credentials = Credentials::new(
            cfg.s3_access_key.clone(),
            cfg.s3_secret_key.clone(),
            None,
            None,
            "minio-static",
        );
        let base = aws_sdk_s3::config::Builder::new()
            .behavior_version(aws_config::BehaviorVersion::latest())
            .region(Region::new(cfg.s3_region.clone()))
            .credentials_provider(credentials)
            .force_path_style(true);
        let ops = Client::from_conf(base.clone().endpoint_url(&cfg.s3_endpoint_internal).build());
        let public = Client::from_conf(base.endpoint_url(&cfg.s3_endpoint_public).build());
        Self { ops, public }
    }

    /// Readiness probe: HEAD the bucket on the internal endpoint.
    pub async fn bucket_exists(&self, bucket: &str) -> anyhow::Result<()> {
        self.ops
            .head_bucket()
            .bucket(bucket)
            .send()
            .await
            .with_context(|| format!("head bucket {bucket}"))?;
        Ok(())
    }
}

impl BlobStore for S3BlobStore {
    async fn put_object(&self, bucket: &str, key: &str, bytes: Vec<u8>) -> anyhow::Result<()> {
        self.ops
            .put_object()
            .bucket(bucket)
            .key(key)
            .body(ByteStream::from(bytes))
            .send()
            .await
            .with_context(|| format!("put s3://{bucket}/{key}"))?;
        Ok(())
    }

    async fn get_object(&self, bucket: &str, key: &str) -> anyhow::Result<Vec<u8>> {
        let resp = self
            .ops
            .get_object()
            .bucket(bucket)
            .key(key)
            .send()
            .await
            .with_context(|| format!("get s3://{bucket}/{key}"))?;
        let data = resp
            .body
            .collect()
            .await
            .with_context(|| format!("read body of s3://{bucket}/{key}"))?;
        Ok(data.into_bytes().to_vec())
    }

    async fn delete_object(&self, bucket: &str, key: &str) -> anyhow::Result<()> {
        self.ops
            .delete_object()
            .bucket(bucket)
            .key(key)
            .send()
            .await
            .with_context(|| format!("delete s3://{bucket}/{key}"))?;
        Ok(())
    }

    async fn head(&self, bucket: &str, key: &str) -> anyhow::Result<bool> {
        match self.ops.head_object().bucket(bucket).key(key).send().await {
            Ok(_) => Ok(true),
            Err(SdkError::ServiceError(err)) if err.err().is_not_found() => Ok(false),
            Err(e) => Err(anyhow::Error::from(e)).context(format!("head s3://{bucket}/{key}")),
        }
    }

    async fn presign_put(&self, bucket: &str, key: &str, ttl: Duration) -> anyhow::Result<String> {
        let config = PresigningConfig::expires_in(ttl).context("presign ttl")?;
        let presigned = self
            .public
            .put_object()
            .bucket(bucket)
            .key(key)
            .presigned(config)
            .await
            .with_context(|| format!("presign PUT s3://{bucket}/{key}"))?;
        Ok(presigned.uri().to_string())
    }

    async fn presign_get(&self, bucket: &str, key: &str, ttl: Duration) -> anyhow::Result<String> {
        let config = PresigningConfig::expires_in(ttl).context("presign ttl")?;
        let presigned = self
            .public
            .get_object()
            .bucket(bucket)
            .key(key)
            .presigned(config)
            .await
            .with_context(|| format!("presign GET s3://{bucket}/{key}"))?;
        Ok(presigned.uri().to_string())
    }
}
