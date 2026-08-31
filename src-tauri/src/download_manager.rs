// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::sync::{Mutex, RwLock};

/// Strip the query string and fragment off a URL before quoting it
/// in a user-facing error. Vimeo proxy URLs and Cloudflare Images
/// signed URLs both carry credentials in the query, so leaking those
/// into UI tooltips or `error_detail` analytics payloads would be a
/// regression. Returns the input unchanged if no `?` or `#` is
/// present, and bails out cleanly on malformed URLs.
fn redact_url_query(url: &str) -> String {
    let cutoff = url
        .find('?')
        .into_iter()
        .chain(url.find('#'))
        .min()
        .unwrap_or(url.len());
    url[..cutoff].to_string()
}

/// Metadata stored alongside each downloaded dataset.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadedDataset {
    pub dataset_id: String,
    pub title: String,
    pub format: String,
    /// "video" or "image"
    pub kind: String,
    /// Primary asset filename (e.g. "video.mp4" or "image_4096.jpg")
    pub primary_file: String,
    /// Caption filename if present
    pub caption_file: Option<String>,
    /// Thumbnail filename if present
    pub thumbnail_file: Option<String>,
    /// Legend filename if present
    pub legend_file: Option<String>,
    /// Total size of all files in bytes
    pub total_bytes: u64,
    /// ISO 8601 timestamp of download completion
    pub downloaded_at: String,
}

/// Status of an active download.
#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgress {
    pub dataset_id: String,
    pub title: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub phase: String,
}

/// Index file that tracks all downloaded datasets.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct DownloadIndex {
    datasets: HashMap<String, DownloadedDataset>,
}

/// Manages dataset downloads with progress tracking and local storage.
pub struct DownloadManager {
    base_dir: PathBuf,
    client: reqwest::Client,
    index: RwLock<DownloadIndex>,
    /// Active download cancellation tokens (dataset_id → cancel flag)
    active: Mutex<HashMap<String, Arc<tokio::sync::watch::Sender<bool>>>>,
}

impl DownloadManager {
    pub fn new(base_dir: PathBuf) -> Self {
        let client = reqwest::Client::builder()
            .user_agent("InteractiveSphere/0.1")
            .build()
            .expect("failed to build HTTP client");

        let index = Self::load_index(&base_dir).unwrap_or_default();

        Self {
            base_dir,
            client,
            index: RwLock::new(index),
            active: Mutex::new(HashMap::new()),
        }
    }

    fn index_path(base_dir: &PathBuf) -> PathBuf {
        base_dir.join("index.json")
    }

    fn load_index(base_dir: &PathBuf) -> Option<DownloadIndex> {
        let path = Self::index_path(base_dir);
        let data = std::fs::read_to_string(path).ok()?;
        serde_json::from_str(&data).ok()
    }

    async fn save_index(&self) {
        let index = self.index.read().await;
        let path = Self::index_path(&self.base_dir);
        if let Ok(data) = serde_json::to_string_pretty(&*index) {
            let _ = tokio::fs::write(path, data).await;
        }
    }

    fn dataset_dir(&self, dataset_id: &str) -> PathBuf {
        // Sanitize the dataset ID for use as a directory name
        let safe_id =
            dataset_id.replace(|c: char| !c.is_alphanumeric() && c != '_' && c != '-', "_");
        self.base_dir.join(safe_id)
    }

    /// List all downloaded datasets.
    pub async fn list(&self) -> Vec<DownloadedDataset> {
        let index = self.index.read().await;
        index.datasets.values().cloned().collect()
    }

    /// Check if a dataset is downloaded and return its info.
    pub async fn get(&self, dataset_id: &str) -> Option<DownloadedDataset> {
        let index = self.index.read().await;
        index.datasets.get(dataset_id).cloned()
    }

    /// Get the local file path for a downloaded dataset's primary asset.
    pub async fn get_asset_path(&self, dataset_id: &str, filename: &str) -> Option<PathBuf> {
        let index = self.index.read().await;
        if !index.datasets.contains_key(dataset_id) {
            return None;
        }
        let path = self.dataset_dir(dataset_id).join(filename);
        if path.exists() {
            Some(path)
        } else {
            None
        }
    }

    /// Delete a downloaded dataset and its files.
    pub async fn delete(&self, dataset_id: &str) -> Result<(), String> {
        // Cancel if in progress
        self.cancel(dataset_id).await;

        let dir = self.dataset_dir(dataset_id);
        if dir.exists() {
            tokio::fs::remove_dir_all(&dir)
                .await
                .map_err(|e| format!("Failed to delete dataset files: {e}"))?;
        }

        let mut index = self.index.write().await;
        index.datasets.remove(dataset_id);
        drop(index);
        self.save_index().await;
        Ok(())
    }

    /// Cancel an active download.
    pub async fn cancel(&self, dataset_id: &str) {
        let mut active = self.active.lock().await;
        if let Some(cancel_tx) = active.remove(dataset_id) {
            let _ = cancel_tx.send(true);
        }
    }

    /// Check if a download is currently active.
    pub async fn is_downloading(&self, dataset_id: &str) -> bool {
        let active = self.active.lock().await;
        active.contains_key(dataset_id)
    }

    /// Download a file from a URL to a local path, reporting progress.
    /// Returns the number of bytes written.
    async fn download_file(
        &self,
        url: &str,
        dest: &PathBuf,
        cancel_rx: &mut tokio::sync::watch::Receiver<bool>,
    ) -> Result<u64, String> {
        // We want enough URL context in user-facing errors to tell
        // which asset failed (the dataset has up to four), but the
        // Vimeo proxy and Cloudflare Images both return signed,
        // time-limited URLs whose query strings contain access
        // tokens. Strip the query + fragment before formatting so
        // we never bake credentials into UI tooltips or analytics
        // error_detail payloads.
        //
        // The redacted URL is also written to the Rust log at debug
        // level (below) so operators can correlate the user-facing
        // error with the in-process attempt without grepping for
        // tokens. We deliberately do NOT log the full URL: debug
        // logs end up in CI artifacts, support bundles, and screen
        // shares, so the same redaction story applies there.
        let redacted = redact_url_query(url);
        log::debug!("download_file: GET {redacted} -> {dest:?}");
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("HTTP request failed for {redacted}: {e}"))?;

        if !response.status().is_success() {
            return Err(format!(
                "Server returned {} for {redacted}",
                response.status()
            ));
        }

        let mut stream = response.bytes_stream();
        let mut file = tokio::fs::File::create(dest)
            .await
            .map_err(|e| format!("Failed to create file: {e}"))?;

        let mut written: u64 = 0;
        use futures_util::StreamExt;
        use tokio::io::AsyncWriteExt;

        while let Some(chunk) = stream.next().await {
            // Check for cancellation
            if *cancel_rx.borrow() {
                drop(file);
                let _ = tokio::fs::remove_file(dest).await;
                return Err("Download cancelled".into());
            }

            let chunk = chunk.map_err(|e| format!("Stream error: {e}"))?;
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("Write error: {e}"))?;
            written += chunk.len() as u64;
        }

        file.flush()
            .await
            .map_err(|e| format!("Flush error: {e}"))?;
        Ok(written)
    }

    /// Download a dataset's assets. Called from a Tauri command.
    ///
    /// `assets` is a list of (url, filename) pairs to download.
    /// `meta` is the metadata to store in the index on completion.
    pub async fn download(
        &self,
        dataset_id: &str,
        assets: Vec<(String, String)>,
        meta: DownloadedDataset,
        app_handle: tauri::AppHandle,
    ) -> Result<(), String> {
        // Set up cancellation
        let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
        {
            let mut active = self.active.lock().await;
            if active.contains_key(dataset_id) {
                return Err("Download already in progress".into());
            }
            active.insert(dataset_id.to_string(), Arc::new(cancel_tx));
        }

        let dir = self.dataset_dir(dataset_id);
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| format!("Failed to create dataset directory: {e}"))?;

        let mut total_bytes: u64 = 0;

        for (i, (url, filename)) in assets.iter().enumerate() {
            if *cancel_rx.borrow() {
                // Clean up partial download
                let _ = tokio::fs::remove_dir_all(&dir).await;
                self.active.lock().await.remove(dataset_id);
                return Err("Download cancelled".into());
            }

            let dest = dir.join(filename);
            let phase = format!("Downloading file {} of {}", i + 1, assets.len());

            // Emit progress event
            let progress = DownloadProgress {
                dataset_id: dataset_id.to_string(),
                title: meta.title.clone(),
                downloaded_bytes: total_bytes,
                total_bytes: 0, // We don't know total ahead of time for all files
                phase,
            };
            let _ = app_handle.emit("download-progress", &progress);

            match self.download_file(&url, &dest, &mut cancel_rx).await {
                Ok(bytes) => total_bytes += bytes,
                Err(e) => {
                    // Clean up on failure
                    let _ = tokio::fs::remove_dir_all(&dir).await;
                    self.active.lock().await.remove(dataset_id);
                    return Err(e);
                }
            }
        }

        // Save completed metadata with actual total size
        let completed = DownloadedDataset {
            total_bytes,
            downloaded_at: chrono::Utc::now().to_rfc3339(),
            ..meta
        };

        {
            let mut index = self.index.write().await;
            index.datasets.insert(dataset_id.to_string(), completed);
        }
        self.save_index().await;

        // Remove from active downloads
        self.active.lock().await.remove(dataset_id);

        // Emit completion event
        let _ = app_handle.emit("download-complete", dataset_id);

        Ok(())
    }

    /// Get total disk usage of all downloaded datasets.
    pub async fn total_size(&self) -> u64 {
        let index = self.index.read().await;
        index.datasets.values().map(|d| d.total_bytes).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_query_string_from_signed_vimeo_proxy_url() {
        let url =
            "https://video-proxy.zyra-project.org/12345/master.mp4?token=abc.signed&expires=9999";
        assert_eq!(
            redact_url_query(url),
            "https://video-proxy.zyra-project.org/12345/master.mp4"
        );
    }

    #[test]
    fn redacts_fragment_from_url() {
        let url = "https://r2.example/foo.jpg#section";
        assert_eq!(redact_url_query(url), "https://r2.example/foo.jpg");
    }

    #[test]
    fn picks_earliest_of_question_mark_or_hash() {
        let url = "https://r2.example/foo.jpg?a=1#frag";
        assert_eq!(redact_url_query(url), "https://r2.example/foo.jpg");
    }

    #[test]
    fn returns_url_unchanged_when_no_query_or_fragment() {
        let url = "https://r2.example/datasets/01KQG/image_4096.jpg";
        assert_eq!(redact_url_query(url), url);
    }
}
