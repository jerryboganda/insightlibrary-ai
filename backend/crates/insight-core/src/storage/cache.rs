//! Cache + pub/sub over Redis/Valkey using the auto-reconnecting
//! `ConnectionManager`. `publish` backs the later WebSocket fan-out.

use anyhow::Context;
use redis::aio::ConnectionManager;
use redis::AsyncCommands;

/// Key/value cache + pub/sub. Native async-fn-in-trait.
#[allow(async_fn_in_trait)]
pub trait Cache {
    async fn get(&self, key: &str) -> anyhow::Result<Option<String>>;
    async fn set_with_ttl(&self, key: &str, value: &str, ttl_secs: u64) -> anyhow::Result<()>;
    /// SET NX EX: store only when absent. `true` when this call set the key
    /// (idempotency-key reservation, refresh-token allowlist).
    async fn set_nx_with_ttl(&self, key: &str, value: &str, ttl_secs: u64) -> anyhow::Result<bool>;
    async fn del(&self, key: &str) -> anyhow::Result<()>;
    /// GETDEL: atomically read and delete. `Some` means THIS caller consumed
    /// the key (single-use tokens — two concurrent callers cannot both win).
    async fn take(&self, key: &str) -> anyhow::Result<Option<String>>;
    async fn incr(&self, key: &str) -> anyhow::Result<i64>;
    /// Set a TTL on an existing key (rate-limit windows).
    async fn expire(&self, key: &str, ttl_secs: i64) -> anyhow::Result<()>;
    /// Remaining TTL in seconds (`None` when the key has no TTL / is gone).
    async fn ttl(&self, key: &str) -> anyhow::Result<Option<i64>>;
    /// Publish `payload` on `channel` (WS fan-out in later phases).
    async fn publish(&self, channel: &str, payload: &str) -> anyhow::Result<()>;
}

/// Redis-backed [`Cache`]. Cheap to clone; the manager multiplexes and
/// reconnects automatically.
#[derive(Clone)]
pub struct RedisCache {
    conn: ConnectionManager,
}

impl RedisCache {
    pub async fn connect(url: &str) -> anyhow::Result<Self> {
        let client = redis::Client::open(url).context("parsing redis url")?;
        let conn = client
            .get_connection_manager()
            .await
            .context("connecting redis connection manager")?;
        Ok(Self { conn })
    }

    /// Readiness probe.
    pub async fn ping(&self) -> anyhow::Result<()> {
        let mut conn = self.conn.clone();
        let pong: String = redis::cmd("PING")
            .query_async(&mut conn)
            .await
            .context("redis ping")?;
        anyhow::ensure!(pong == "PONG", "unexpected PING reply: {pong}");
        Ok(())
    }
}

impl Cache for RedisCache {
    async fn get(&self, key: &str) -> anyhow::Result<Option<String>> {
        let mut conn = self.conn.clone();
        let value: Option<String> = conn.get(key).await.context("redis GET")?;
        Ok(value)
    }

    async fn set_with_ttl(&self, key: &str, value: &str, ttl_secs: u64) -> anyhow::Result<()> {
        let mut conn = self.conn.clone();
        let _: () = conn
            .set_ex(key, value, ttl_secs)
            .await
            .context("redis SETEX")?;
        Ok(())
    }

    async fn set_nx_with_ttl(&self, key: &str, value: &str, ttl_secs: u64) -> anyhow::Result<bool> {
        let mut conn = self.conn.clone();
        let set: Option<String> = redis::cmd("SET")
            .arg(key)
            .arg(value)
            .arg("NX")
            .arg("EX")
            .arg(ttl_secs)
            .query_async(&mut conn)
            .await
            .context("redis SET NX EX")?;
        Ok(set.is_some())
    }

    async fn del(&self, key: &str) -> anyhow::Result<()> {
        let mut conn = self.conn.clone();
        let _: () = conn.del(key).await.context("redis DEL")?;
        Ok(())
    }

    async fn take(&self, key: &str) -> anyhow::Result<Option<String>> {
        let mut conn = self.conn.clone();
        let value: Option<String> = redis::cmd("GETDEL")
            .arg(key)
            .query_async(&mut conn)
            .await
            .context("redis GETDEL")?;
        Ok(value)
    }

    async fn incr(&self, key: &str) -> anyhow::Result<i64> {
        let mut conn = self.conn.clone();
        let value: i64 = conn.incr(key, 1).await.context("redis INCR")?;
        Ok(value)
    }

    async fn expire(&self, key: &str, ttl_secs: i64) -> anyhow::Result<()> {
        let mut conn = self.conn.clone();
        let _: bool = conn.expire(key, ttl_secs).await.context("redis EXPIRE")?;
        Ok(())
    }

    async fn ttl(&self, key: &str) -> anyhow::Result<Option<i64>> {
        let mut conn = self.conn.clone();
        let ttl: i64 = conn.ttl(key).await.context("redis TTL")?;
        Ok((ttl >= 0).then_some(ttl))
    }

    async fn publish(&self, channel: &str, payload: &str) -> anyhow::Result<()> {
        let mut conn = self.conn.clone();
        let _: () = conn
            .publish(channel, payload)
            .await
            .context("redis PUBLISH")?;
        Ok(())
    }
}
