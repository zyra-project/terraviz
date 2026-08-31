// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

const GIBS_BASE: &str = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";

const ALLOWED_PREFIXES: &[&str] = &["BlueMarble_NextGeneration/", "VIIRS_Black_Marble/"];

#[derive(Debug)]
pub enum TileError {
    Forbidden(String),
    InvalidPath(String),
    Network(String),
    Io(std::io::Error),
}

impl std::fmt::Display for TileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TileError::Forbidden(msg) => write!(f, "forbidden: {msg}"),
            TileError::InvalidPath(msg) => write!(f, "invalid path: {msg}"),
            TileError::Network(msg) => write!(f, "network error: {msg}"),
            TileError::Io(e) => write!(f, "I/O error: {e}"),
        }
    }
}

impl From<std::io::Error> for TileError {
    fn from(e: std::io::Error) -> Self {
        TileError::Io(e)
    }
}

pub struct TileCache {
    cache_dir: PathBuf,
    client: reqwest::Client,
}

impl TileCache {
    pub fn new(cache_dir: PathBuf) -> Self {
        let client = reqwest::Client::builder()
            .user_agent("InteractiveSphere/0.1")
            .build()
            .expect("failed to build HTTP client");
        Self { cache_dir, client }
    }

    /// Validate that a tile path is safe and allowed.
    fn validate(tile_path: &str) -> Result<(), TileError> {
        if tile_path.contains("..") || tile_path.contains('\\') {
            return Err(TileError::InvalidPath("path traversal rejected".into()));
        }
        if tile_path.is_empty() {
            return Err(TileError::InvalidPath("empty path".into()));
        }
        if !ALLOWED_PREFIXES.iter().any(|p| tile_path.starts_with(p)) {
            return Err(TileError::Forbidden(format!(
                "layer not allowed: {}",
                tile_path.split('/').next().unwrap_or("")
            )));
        }
        Ok(())
    }

    /// Map a tile path to a flat cache filename using SHA-256.
    fn cache_path(&self, tile_path: &str) -> PathBuf {
        let mut hasher = Sha256::new();
        hasher.update(tile_path.as_bytes());
        let hash = hex::encode(hasher.finalize());

        // Preserve original extension for debugging/inspection
        let ext = tile_path
            .rsplit('.')
            .next()
            .filter(|e| *e == "jpg" || *e == "png" || *e == "jpeg")
            .unwrap_or("bin");

        self.cache_dir.join(format!("{hash}.{ext}"))
    }

    /// Get a tile — cache-first, then fetch from GIBS on miss.
    /// Returns the raw image bytes.
    pub async fn get_tile(&self, tile_path: &str) -> Result<Vec<u8>, TileError> {
        Self::validate(tile_path)?;

        let cached = self.cache_path(tile_path);

        // Cache hit — read from disk
        if cached.exists() {
            return tokio::fs::read(&cached).await.map_err(TileError::Io);
        }

        // Cache miss — fetch from GIBS
        let url = format!("{GIBS_BASE}/{tile_path}");
        let response = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| TileError::Network(format!("request failed: {e}")))?;

        if !response.status().is_success() {
            return Err(TileError::Network(format!(
                "GIBS returned {}",
                response.status()
            )));
        }

        let bytes = response
            .bytes()
            .await
            .map_err(|e| TileError::Network(format!("body read failed: {e}")))?;

        // Write to cache (best-effort — don't fail the request if write fails)
        if let Err(e) = tokio::fs::write(&cached, &bytes).await {
            log::warn!("Failed to cache tile {tile_path}: {e}");
        }

        Ok(bytes.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_cache(dir: &str) -> TileCache {
        TileCache::new(PathBuf::from(dir))
    }

    #[test]
    fn cache_path_is_deterministic() {
        let cache = test_cache("/tmp/tiles");
        let path1 = cache.cache_path(
            "BlueMarble_NextGeneration/default/2004-08/GoogleMapsCompatible_Level8/0/0/0.jpg",
        );
        let path2 = cache.cache_path(
            "BlueMarble_NextGeneration/default/2004-08/GoogleMapsCompatible_Level8/0/0/0.jpg",
        );
        assert_eq!(path1, path2);
    }

    #[test]
    fn cache_path_differs_for_different_tiles() {
        let cache = test_cache("/tmp/tiles");
        let path1 = cache.cache_path(
            "BlueMarble_NextGeneration/default/2004-08/GoogleMapsCompatible_Level8/0/0/0.jpg",
        );
        let path2 = cache.cache_path(
            "BlueMarble_NextGeneration/default/2004-08/GoogleMapsCompatible_Level8/1/0/0.jpg",
        );
        assert_ne!(path1, path2);
    }

    #[test]
    fn cache_path_preserves_extension() {
        let cache = test_cache("/tmp/tiles");
        let jpg = cache.cache_path(
            "BlueMarble_NextGeneration/default/2004-08/GoogleMapsCompatible_Level8/0/0/0.jpg",
        );
        let png = cache.cache_path(
            "VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/0/0/0.png",
        );
        assert!(jpg.to_str().unwrap().ends_with(".jpg"));
        assert!(png.to_str().unwrap().ends_with(".png"));
    }

    #[test]
    fn validate_allows_blue_marble() {
        assert!(TileCache::validate(
            "BlueMarble_NextGeneration/default/2004-08/GoogleMapsCompatible_Level8/2/1/3.jpg"
        )
        .is_ok());
    }

    #[test]
    fn validate_allows_black_marble() {
        assert!(TileCache::validate(
            "VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/0/0/0.png"
        )
        .is_ok());
    }

    #[test]
    fn validate_rejects_unknown_layer() {
        let err = TileCache::validate("SomeOtherLayer/default/2024-01-01/0/0/0.jpg");
        assert!(err.is_err());
        assert!(matches!(err.unwrap_err(), TileError::Forbidden(_)));
    }

    #[test]
    fn validate_rejects_path_traversal() {
        let err = TileCache::validate("BlueMarble_NextGeneration/../../../etc/passwd");
        assert!(err.is_err());
        assert!(matches!(err.unwrap_err(), TileError::InvalidPath(_)));
    }

    #[test]
    fn validate_rejects_backslash() {
        let err = TileCache::validate("BlueMarble_NextGeneration\\..\\etc\\passwd");
        assert!(err.is_err());
        assert!(matches!(err.unwrap_err(), TileError::InvalidPath(_)));
    }

    #[test]
    fn validate_rejects_empty_path() {
        let err = TileCache::validate("");
        assert!(err.is_err());
        assert!(matches!(err.unwrap_err(), TileError::InvalidPath(_)));
    }
}
