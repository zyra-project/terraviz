// Tauri app entry point — shared between desktop and mobile (iOS / Android).
// Desktop launches via `main.rs` which calls `run()`; mobile launches via the
// `mobile_entry_point` macro below, which the OS-native host (Android JNI or
// iOS Swift shell) loads as a cdylib symbol.

mod download_commands;
mod download_manager;
mod keychain;
mod tile_cache;

use std::sync::Arc;
use base64::Engine;
use tauri::Manager;
use download_manager::DownloadManager;
use tile_cache::TileCache;

#[tauri::command]
async fn get_tile(
    tile_path: String,
    state: tauri::State<'_, Arc<TileCache>>,
) -> Result<String, String> {
    let bytes = state
        .get_tile(&tile_path)
        .await
        .map_err(|e| e.to_string())?;

    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `mut` is only meaningful on desktop, where the cfg block below reassigns
    // `builder` to add the updater plugin. On mobile that block is cfg'd out
    // and the binding is never reassigned.
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        // Phase 4: Apple Intelligence on-device LLM. On non-iOS platforms the
        // plugin's commands return "not available" gracefully; the JS provider
        // checks availability and falls back to HTTP automatically.
        .plugin(tauri_plugin_apple_intelligence::init());

    // The updater plugin is desktop-only — App Store and Play Store handle
    // updates on iOS and Android. See docs/MOBILE_APP_PLAN.md.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .setup(|app| {
            let app_data = app.path().app_data_dir()
                .expect("failed to resolve app data directory");
            let cache_dir = app_data.join("tiles");
            std::fs::create_dir_all(&cache_dir)
                .expect("failed to create tile cache directory");

            let tile_cache = Arc::new(TileCache::new(cache_dir));
            app.manage(tile_cache);

            let dataset_dir = app_data.join("datasets");
            std::fs::create_dir_all(&dataset_dir)
                .expect("failed to create dataset download directory");
            let download_manager = Arc::new(DownloadManager::new(dataset_dir));
            app.manage(download_manager);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_tile,
            keychain::get_api_key,
            keychain::set_api_key,
            download_commands::download_dataset,
            download_commands::cancel_download,
            download_commands::list_downloads,
            download_commands::get_download,
            download_commands::delete_download,
            download_commands::get_download_path,
            download_commands::get_downloads_size,
            download_commands::is_downloading,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
