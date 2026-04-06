use std::sync::Arc;

use serde::Deserialize;
use tauri::Emitter;

use crate::download_manager::{DownloadManager, DownloadedDataset};

/// Asset descriptor passed from the frontend.
#[derive(Debug, Deserialize)]
pub struct AssetInput {
    pub url: String,
    pub filename: String,
}

/// Input for starting a download.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadInput {
    pub dataset_id: String,
    pub title: String,
    pub format: String,
    pub kind: String,
    pub primary_file: String,
    pub caption_file: Option<String>,
    pub thumbnail_file: Option<String>,
    pub legend_file: Option<String>,
    pub assets: Vec<AssetInput>,
}

/// Start downloading a dataset's assets in the background.
#[tauri::command]
pub async fn download_dataset(
    input: DownloadInput,
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<DownloadManager>>,
) -> Result<(), String> {
    let assets: Vec<(String, String)> = input
        .assets
        .into_iter()
        .map(|a| (a.url, a.filename))
        .collect();

    let meta = DownloadedDataset {
        dataset_id: input.dataset_id.clone(),
        title: input.title,
        format: input.format,
        kind: input.kind,
        primary_file: input.primary_file,
        caption_file: input.caption_file,
        thumbnail_file: input.thumbnail_file,
        legend_file: input.legend_file,
        total_bytes: 0,
        downloaded_at: String::new(),
    };

    let manager = Arc::clone(&state);
    let dataset_id = input.dataset_id;

    // Spawn the download in a background task so the command returns immediately
    tauri::async_runtime::spawn(async move {
        if let Err(e) = manager.download(&dataset_id, assets, meta, app.clone()).await {
            log::error!("Download failed for {}: {}", dataset_id, e);
            let _ = app.emit("download-error", (&dataset_id, &e));
        }
    });

    Ok(())
}

/// Cancel an in-progress download.
#[tauri::command]
pub async fn cancel_download(
    dataset_id: String,
    state: tauri::State<'_, Arc<DownloadManager>>,
) -> Result<(), String> {
    state.cancel(&dataset_id).await;
    Ok(())
}

/// List all downloaded datasets.
#[tauri::command]
pub async fn list_downloads(
    state: tauri::State<'_, Arc<DownloadManager>>,
) -> Result<Vec<DownloadedDataset>, String> {
    Ok(state.list().await)
}

/// Check if a specific dataset is downloaded.
#[tauri::command]
pub async fn get_download(
    dataset_id: String,
    state: tauri::State<'_, Arc<DownloadManager>>,
) -> Result<Option<DownloadedDataset>, String> {
    Ok(state.get(&dataset_id).await)
}

/// Delete a downloaded dataset.
#[tauri::command]
pub async fn delete_download(
    dataset_id: String,
    state: tauri::State<'_, Arc<DownloadManager>>,
) -> Result<(), String> {
    state.delete(&dataset_id).await
}

/// Get the local filesystem path for a downloaded asset.
/// Returns the path as a string, or null if not found.
#[tauri::command]
pub async fn get_download_path(
    dataset_id: String,
    filename: String,
    state: tauri::State<'_, Arc<DownloadManager>>,
) -> Result<Option<String>, String> {
    Ok(state
        .get_asset_path(&dataset_id, &filename)
        .await
        .map(|p| p.to_string_lossy().to_string()))
}

/// Get total disk usage of all downloaded datasets.
#[tauri::command]
pub async fn get_downloads_size(
    state: tauri::State<'_, Arc<DownloadManager>>,
) -> Result<u64, String> {
    Ok(state.total_size().await)
}

/// Check if a download is currently in progress.
#[tauri::command]
pub async fn is_downloading(
    dataset_id: String,
    state: tauri::State<'_, Arc<DownloadManager>>,
) -> Result<bool, String> {
    Ok(state.is_downloading(&dataset_id).await)
}
