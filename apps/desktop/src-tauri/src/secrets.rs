//! Secure secret storage backed by the OS credential store (keyring crate):
//! Windows Credential Manager / macOS Keychain / Linux Secret Service.
//!
//! The frontend platform adapter (apps/app/src/lib/platform/tauri.ts) calls
//! these commands to hold the session bearer token — it must never live in
//! webview localStorage, which ships in plaintext inside the app data dir.

const SERVICE: &str = "ai.insightlibrary.desktop";

fn entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secrets_get(key: String) -> Result<Option<String>, String> {
    match entry(&key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn secrets_set(key: String, value: String) -> Result<(), String> {
    entry(&key)?.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secrets_delete(key: String) -> Result<(), String> {
    match entry(&key)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
