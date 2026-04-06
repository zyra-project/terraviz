// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod keychain;
mod tile_cache;

use std::sync::Arc;
use base64::Engine;
use tauri::Manager;
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            let app_data = app.path().app_data_dir()
                .expect("failed to resolve app data directory");
            let cache_dir = app_data.join("tiles");
            std::fs::create_dir_all(&cache_dir)
                .expect("failed to create tile cache directory");

            let tile_cache = Arc::new(TileCache::new(cache_dir));
            app.manage(tile_cache);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_tile,
            keychain::get_api_key,
            keychain::set_api_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
