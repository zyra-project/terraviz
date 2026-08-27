-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 The Zyra Project

-- Non-YouTube video-suggestion sources (task: video-sitemap media
-- source). The counterpart of `feed_connectors` (which ingests *events*)
-- and `youtube_channels` (which filters a live YouTube search): a node's
-- publishers register agency Video Sitemaps here, a scheduled job
-- materializes their entries into `video_index` (with an embedding), and
-- the "suggested media" engine cosine-matches those videos against an
-- event or blog. Generic by design — NOAA Ocean Today is the first
-- source, any standard video sitemap drops in. Single-node D1, additive
-- only.

-- The operator registry: one row per registered sitemap.
CREATE TABLE IF NOT EXISTS video_sources (
  id              TEXT PRIMARY KEY,               -- ULID
  kind            TEXT NOT NULL DEFAULT 'video-sitemap',
  label           TEXT NOT NULL,                  -- display + provenance ("NOAA Ocean Today")
  url             TEXT NOT NULL,                  -- the sitemap URL
  attribution     TEXT,                           -- card attribution; defaults to label when null
  enabled         INTEGER NOT NULL DEFAULT 1,     -- 0 = paused (kept, not indexed/matched)
  added_by        TEXT,                           -- publishers.id (nullable for service)
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_run_at     TEXT,                           -- last refresh attempt
  last_run_status TEXT,                           -- 'ok' | 'error'
  last_run_error  TEXT,                           -- human-readable, when status='error'
  last_run_count  INTEGER,                        -- videos indexed on the last ok run
  FOREIGN KEY (added_by) REFERENCES publishers(id)
);

-- The materialized, embedded videos. One row per sitemap <url> entry,
-- deduped on (source_id, external_id). The embedding is the 768-dim
-- BGE vector stored as a little-endian Float32 BLOB (283 videos × ~3 KB
-- is small enough to cosine-scan in-Worker — no Vectorize index to
-- manage). `content_host` is denormalized so the media-proxy / native-
-- <video> host allowlist is a cheap DISTINCT over enabled sources.
CREATE TABLE IF NOT EXISTS video_index (
  id                TEXT PRIMARY KEY,             -- ULID
  source_id         TEXT NOT NULL,
  external_id       TEXT NOT NULL,                -- the entry page URL (dedupe key within a source)
  page_url          TEXT NOT NULL,                -- citation / source link
  title             TEXT NOT NULL,
  description       TEXT,
  tags_json         TEXT,                         -- JSON array of filtered tags
  category          TEXT,
  content_url       TEXT NOT NULL,                -- direct media file
  content_host      TEXT NOT NULL,                -- lowercased host of content_url (allowlist unit)
  thumbnail_url     TEXT,
  duration_sec      INTEGER,
  published_at      TEXT,                         -- ISO
  embedding         BLOB,                         -- Float32 LE, 768 dims; NULL until embedded
  embedding_version INTEGER,                      -- EMBEDDING_MODEL_VERSION stamp
  embed_text_hash   TEXT,                         -- hash of the embed input; skip re-embed when unchanged
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (source_id, external_id),
  FOREIGN KEY (source_id) REFERENCES video_sources(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_video_index_source ON video_index (source_id);
CREATE INDEX IF NOT EXISTS idx_video_index_host ON video_index (content_host);
