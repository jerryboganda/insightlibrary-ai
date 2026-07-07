//! Small security primitives (Phase 12): API-key generation + hashing and
//! webhook HMAC-SHA256 signatures. Pure functions, no I/O.

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// Hex-encode bytes.
fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// SHA-256 hex digest of `input` — used to store API keys as a lookup hash.
pub fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex(&hasher.finalize())
}

/// HMAC-SHA256 hex signature of `body` under `secret` — the webhook signature.
pub fn hmac_sha256_hex(secret: &str, body: &str) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(body.as_bytes());
    hex(&mac.finalize().into_bytes())
}

/// A freshly minted API key: the plaintext (shown to the user ONCE) plus its
/// storage hash and a non-secret display hint (last 4 chars).
pub struct NewApiKey {
    pub plaintext: String,
    pub hash: String,
    pub hint: String,
}

/// Generate a `sk_live_`-prefixed key (128 bits of CSPRNG entropy via two v4
/// UUIDs) and its SHA-256 storage hash.
pub fn generate_api_key() -> NewApiKey {
    let a = Uuid::new_v4().simple().to_string();
    let b = Uuid::new_v4().simple().to_string();
    let plaintext = format!("sk_live_{a}{b}");
    let hash = sha256_hex(&plaintext);
    let hint = plaintext
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    NewApiKey {
        plaintext,
        hash,
        hint,
    }
}

/// A webhook secret (`whsec_`-prefixed).
pub fn generate_webhook_secret() -> String {
    format!("whsec_{}", Uuid::new_v4().simple())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_is_stable() {
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn hmac_is_stable() {
        // RFC 4231-ish sanity: same input → same signature, differs by secret.
        let a = hmac_sha256_hex("secret", "payload");
        let b = hmac_sha256_hex("secret", "payload");
        let c = hmac_sha256_hex("other", "payload");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn api_key_hash_matches() {
        let k = generate_api_key();
        assert!(k.plaintext.starts_with("sk_live_"));
        assert_eq!(sha256_hex(&k.plaintext), k.hash);
        assert_eq!(k.hint.len(), 4);
    }
}
