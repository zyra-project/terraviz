-- 0001_init.sql — Phase 1a — node_identity + datasets core.
--
-- Establishes the node identity row (one row, ULID-keyed) and the
-- datasets table that anchors the catalog. Decoration tables
-- (tags / categories / keywords / developers / related), renditions,
-- tours, publishers, and audit_events arrive in later migrations.
--
-- The datasets table carries every Phase-1a column from
-- CATALOG_DATA_MODEL.md, including columns populated by Phase 1b
-- (content_digest, media intrinsics, embedding_version) and Phase 6
-- (review-queue lifecycle). All those columns are nullable; only the
-- behaviour to populate them lands in later phases. Keeping the
-- column set stable from day one keeps schema_version pinned to 1
-- across the milestone and avoids ALTER TABLE cascades.
--
-- The publisher_id FK references publishers(id) — a table that does
-- not exist until 0005_publishers_audit.sql. SQLite tolerates
-- forward references at CREATE TABLE time; INSERTs with a non-NULL
-- publisher_id will fail until 0005 has applied, which is fine
-- because seed and publisher writes only run post-migration.

CREATE TABLE node_identity (
  node_id            TEXT PRIMARY KEY,        -- ULID, generated at install
  display_name       TEXT NOT NULL,
  base_url           TEXT NOT NULL,           -- https://terraviz.example.org
  description        TEXT,
  contact_email      TEXT,
  public_key         TEXT NOT NULL,           -- Ed25519, base64
  created_at         TEXT NOT NULL
);

CREATE TABLE datasets (
  id                 TEXT PRIMARY KEY,        -- ULID
  slug               TEXT NOT NULL UNIQUE,
  origin_node        TEXT NOT NULL,           -- always = node_identity.node_id for own rows
  title              TEXT NOT NULL,
  abstract           TEXT,
  organization       TEXT,
  format             TEXT NOT NULL,           -- video/mp4, image/png, tour/json, ...
  data_ref           TEXT NOT NULL,           -- stream:<uid> | r2:<key> | vimeo:<id> | url:<url> | peer:<node_id>/<id>

  -- Asset integrity (Phase 1b populates).
  content_digest     TEXT,
  source_digest      TEXT,
  auxiliary_digests  TEXT,                    -- JSON: { "thumbnail": "sha256:...", ... }

  thumbnail_ref           TEXT,
  sphere_thumbnail_ref    TEXT,
  sphere_thumbnail_ref_lg TEXT,
  legend_ref         TEXT,
  caption_ref        TEXT,
  website_link       TEXT,
  start_time         TEXT,                    -- ISO 8601
  end_time           TEXT,
  period             TEXT,                    -- ISO 8601 duration
  weight             INTEGER NOT NULL DEFAULT 0,
  visibility         TEXT NOT NULL DEFAULT 'public',
                                              -- public | federated | restricted | private
  is_hidden          INTEGER NOT NULL DEFAULT 0,
  run_tour_on_load   TEXT,

  -- Media intrinsics (Phase 1b populates).
  width              INTEGER,
  height             INTEGER,
  render_width       INTEGER,
  render_height      INTEGER,
  color_space        TEXT,                    -- rec709 | rec2020-pq | rec2020-hlg | p3 | srgb
  bit_depth          INTEGER,                 -- 8 | 10 | 12
  hdr_transfer       TEXT,                    -- null | pq | hlg
  has_alpha          INTEGER NOT NULL DEFAULT 0,
  alpha_encoding     TEXT,                    -- null | native_vp9 | native_hevc | packed_below | packed_right
  primary_codec      TEXT,                    -- h264 | hevc | vp9 | av1 (informational)

  -- License & attribution (Phase 1a populates from seeded SOS data).
  license_spdx       TEXT,
  license_url        TEXT,
  license_statement  TEXT,
  attribution_text   TEXT,
  rights_holder      TEXT,
  doi                TEXT,
  citation_text      TEXT,

  -- Docent search index tracking (Phase 1b populates).
  embedding_version  INTEGER,

  schema_version     INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,

  -- Review-queue lifecycle (Phase 6 populates; all NULL otherwise).
  submitted_at       TEXT,
  approved_at        TEXT,
  rejected_at        TEXT,
  rejected_reason    TEXT,

  published_at       TEXT,
  retracted_at       TEXT,
  publisher_id       TEXT,
  FOREIGN KEY (publisher_id) REFERENCES publishers(id)
);

CREATE INDEX idx_datasets_visibility ON datasets(visibility, is_hidden, retracted_at);
CREATE INDEX idx_datasets_updated_at ON datasets(updated_at);
CREATE INDEX idx_datasets_publisher  ON datasets(publisher_id);
