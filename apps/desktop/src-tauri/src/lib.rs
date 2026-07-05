mod oauth;
mod secrets;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init());

    // Desktop-only plugins: window-state persistence + signed in-app updates.
    // The updater needs `plugins.updater` (pubkey + endpoints) in tauri.conf.json
    // before it can fetch releases; the plugin itself is wired here so the
    // release pipeline only has to add signing keys. See src-tauri/UPDATER.md.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build());

    builder
        // Experimental ChatGPT OAuth loopback capture state.
        .manage(oauth::OauthState::default())
        // Session-token storage in the OS keyring (bearer auth for the API) +
        // the experimental ChatGPT OAuth sign-in commands.
        .invoke_handler(tauri::generate_handler![
            secrets::secrets_get,
            secrets::secrets_set,
            secrets::secrets_delete,
            oauth::oauth_start,
            oauth::oauth_complete
        ])
        .run(tauri::generate_context!())
        .expect("error while running InsightLibrary AI");
}
