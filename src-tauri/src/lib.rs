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
use serde::Serialize;
use tauri::{Emitter, Manager};
use download_manager::DownloadManager;
use tile_cache::TileCache;

/// Payload emitted on the `native_panic` event when the Rust panic hook
/// fires. Mirrors the shape that
/// `src/analytics/errorCapture.ts`'s listener expects. Kept minimal on
/// purpose — the JS sanitizer (URL / email / digit / file-path
/// stripping) runs on the message before any analytics event is
/// emitted, so passing the raw text here is fine.
#[derive(Debug, Clone, Serialize)]
struct NativePanicPayload {
    /// Best-effort panic message string. Falls back to `"<unknown
    /// panic>"` when the payload isn't a `&str` / `String`.
    message: String,
    /// `file:line` of the panic site, when available. None for panics
    /// without a captured location (rare in practice).
    location: Option<String>,
}

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

/// Dev-only command for the plan's native-panic acceptance check
/// ("force a Rust panic in a dev build, watch a sanitized event
/// appear in the stream"). Always present in the handler list so
/// the macro expansion is stable across build profiles, but the
/// panic body is gated to debug builds. In release this is a
/// no-op — the JS side calling it gets a successful invocation
/// with no observable effect.
#[tauri::command]
fn __dev_force_panic() {
    #[cfg(debug_assertions)]
    {
        panic!("dev-only forced panic for testing native_panic event");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `mut` is only meaningful on desktop, where the cfg block below reassigns
    // `builder` to add the updater plugin. On mobile that block is cfg'd out
    // and the binding is never reassigned.
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_deep_link::init())
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
            // Panic hook — forwards every Rust panic to the JS error
            // capture pipeline as a `native_panic` event. The default
            // hook runs first so Tauri's existing log behaviour (and
            // any process-level panic handler from cargo / OS) keeps
            // working unchanged. Installed inside setup() because we
            // need a clone of the AppHandle for `emit()`; before
            // setup, no app handle exists.
            let panic_emit_handle = app.handle().clone();
            let default_hook = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |panic_info| {
                // Default hook first — preserves stderr/log output.
                default_hook(panic_info);

                // Best-effort message extraction. Rust's panic
                // payloads are commonly &str (panic!("...")) or
                // String (panic!("{}", x)); anything else (custom
                // panic types via panic_any) collapses to a marker.
                let message = panic_info
                    .payload()
                    .downcast_ref::<&str>()
                    .map(|s| (*s).to_string())
                    .or_else(|| {
                        panic_info
                            .payload()
                            .downcast_ref::<String>()
                            .cloned()
                    })
                    .unwrap_or_else(|| "<unknown panic>".to_string());

                let location = panic_info.location().map(|loc| {
                    format!("{}:{}", loc.file(), loc.line())
                });

                let payload = NativePanicPayload { message, location };
                // Best-effort emit — if the JS side isn't listening
                // (window not yet created, app shutting down) this
                // silently no-ops. The default hook above already
                // logged for human readers.
                let _ = panic_emit_handle.emit("native_panic", &payload);
            }));

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
            __dev_force_panic,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
