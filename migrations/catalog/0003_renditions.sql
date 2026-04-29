-- 0003_renditions.sql — Phase 1a — dataset_renditions.
--
-- One row per encoded rendition. Phase 1a leaves this empty for
-- legacy vimeo: / url: data_refs (no rendition information from the
-- SOS catalog). Phase 1b populates rows from the Stream callback on
-- new uploads; the Phase 4-5 "Layered visualisation" follow-on adds
-- packed-alpha and >4K rows from a CI-side ffmpeg pipeline.

CREATE TABLE dataset_renditions (
  dataset_id     TEXT NOT NULL,
  rendition_id   TEXT NOT NULL,               -- ULID
  codec          TEXT NOT NULL,               -- h264 | hevc | vp9 | av1
  color_space    TEXT NOT NULL,
  bit_depth      INTEGER NOT NULL,
  has_alpha      INTEGER NOT NULL DEFAULT 0,
  alpha_encoding TEXT,
  width          INTEGER NOT NULL,            -- encoded width
  height         INTEGER NOT NULL,            -- encoded height
  bitrate_kbps   INTEGER,
  ref            TEXT NOT NULL,               -- stream:<uid>/profile or r2-hls:<key>
  mime_type      TEXT NOT NULL,
  content_digest TEXT,                        -- "sha256:<hex>" of the rendition's master playlist
  created_at     TEXT NOT NULL,
  PRIMARY KEY (dataset_id, rendition_id),
  FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE
);

CREATE INDEX idx_renditions_dataset ON dataset_renditions(dataset_id);
