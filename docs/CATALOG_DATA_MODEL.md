# Catalog Data Model

D1 schema reference for the catalog backend. Companion to
[`CATALOG_BACKEND_PLAN.md`](CATALOG_BACKEND_PLAN.md).

The schema below is the Phase-1 floor. Everything else in the plan
either reads from these tables or adds rows to them.

## Conventions

- Primary keys are ULIDs (lexicographically sortable, URL-safe). The
  string format keeps D1 happy and makes log lines greppable.
- All timestamps are ISO 8601 UTC strings. SQLite has no native
  timestamp type and we need to be JSON-friendly anyway.
- Every catalog-bearing table has a `schema_version INTEGER` column.
  The `/api/v1/catalog` response stamps the highest schema_version
  in the payload so consumers can refuse what they can't parse.
- `origin_node` is denormalized onto every catalog row — even rows
  this node owns — so a federated mirror table can be the same
  schema with a different `origin_node` value.

## Core tables

```sql
-- Identity of this node. Single row.
CREATE TABLE node_identity (
  node_id            TEXT PRIMARY KEY,        -- ULID, generated at install
  display_name       TEXT NOT NULL,
  base_url           TEXT NOT NULL,           -- https://terraviz.example.org
  description        TEXT,
  contact_email      TEXT,
  public_key         TEXT NOT NULL,           -- Ed25519, base64
  created_at         TEXT NOT NULL
);

-- Datasets owned by this node.
CREATE TABLE datasets (
  id                 TEXT PRIMARY KEY,        -- ULID
  slug               TEXT NOT NULL UNIQUE,    -- url-safe, human-typed
  origin_node        TEXT NOT NULL,           -- always = node_identity.node_id
  title              TEXT NOT NULL,
  abstract           TEXT,
  organization       TEXT,
  format             TEXT NOT NULL,           -- video/mp4, image/png, tour/json, ...
  data_ref           TEXT NOT NULL,           -- internal handle: stream:<uid>, r2:<key>, url:<url>
  thumbnail_ref           TEXT,                -- flat 16:9 / 4:3 card image
  sphere_thumbnail_ref    TEXT,                -- 2:1 equirectangular for mini-globe rendering
  sphere_thumbnail_ref_lg TEXT,                -- optional 1024x512 for hero use
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
  run_tour_on_load   TEXT,                    -- tour id

  -- Media intrinsics. Populated at upload time from probe; null for
  -- legacy `vimeo:` and `url:` refs until backfilled. The frontend
  -- uses these to pick a rendition and drive the shader; see
  -- "Beyond 4K, HDR, and transparency" in CATALOG_ASSETS_PIPELINE.md.
  width              INTEGER,                 -- pixels (encoded)
  height             INTEGER,                 -- pixels (encoded)
  render_width       INTEGER,                 -- logical (== width unless packed-alpha)
  render_height      INTEGER,                 -- logical (== height unless packed-alpha)
  color_space        TEXT,                    -- rec709 | rec2020-pq | rec2020-hlg | p3 | srgb
  bit_depth          INTEGER,                 -- 8 | 10 | 12
  hdr_transfer       TEXT,                    -- null | pq | hlg
  has_alpha          INTEGER NOT NULL DEFAULT 0,
  alpha_encoding     TEXT,                    -- null | native_vp9 | native_hevc | packed_below | packed_right
  primary_codec      TEXT,                    -- h264 | hevc | vp9 | av1 — informational; renditions are the source of truth

  -- License & attribution. SPDX identifier for machine-readable
  -- terms; free-text statement for licenses without an SPDX entry
  -- (most government data falls here). Attribution propagates
  -- through federation — a peer mirroring this dataset is bound
  -- by the same terms and must surface attribution_text to its users.
  license_spdx       TEXT,                    -- SPDX identifier (e.g., "CC-BY-4.0", "CC0-1.0")
  license_url        TEXT,                    -- canonical license URL
  license_statement  TEXT,                    -- free-text fallback (NOAA, "U.S. Government Work", etc.)
  attribution_text   TEXT,                    -- one-line credit shown next to the dataset
  rights_holder      TEXT,                    -- copyright holder; null for public-domain works
  doi                TEXT,                    -- optional persistent identifier
  citation_text      TEXT,                    -- optional preformatted citation (BibTeX-friendly)

  schema_version     INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  published_at       TEXT,
  retracted_at       TEXT,
  publisher_id       TEXT,
  FOREIGN KEY (publisher_id) REFERENCES publishers(id)
);

CREATE INDEX idx_datasets_visibility ON datasets(visibility, is_hidden, retracted_at);
CREATE INDEX idx_datasets_updated_at ON datasets(updated_at);
CREATE INDEX idx_datasets_publisher  ON datasets(publisher_id);

-- Many-to-many decoration. Categories collapse to an array on the wire.
CREATE TABLE dataset_tags (
  dataset_id  TEXT NOT NULL,
  tag         TEXT NOT NULL,
  PRIMARY KEY (dataset_id, tag),
  FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE
);

CREATE TABLE dataset_categories (
  dataset_id  TEXT NOT NULL,
  facet       TEXT NOT NULL,                  -- e.g., "Theme", "Region"
  value       TEXT NOT NULL,
  PRIMARY KEY (dataset_id, facet, value),
  FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE
);

CREATE TABLE dataset_keywords (
  dataset_id  TEXT NOT NULL,
  keyword     TEXT NOT NULL,
  PRIMARY KEY (dataset_id, keyword),
  FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE
);

CREATE TABLE dataset_developers (
  dataset_id      TEXT NOT NULL,
  role            TEXT NOT NULL,              -- 'data' | 'visualization'
  name            TEXT NOT NULL,
  affiliation_url TEXT,
  PRIMARY KEY (dataset_id, role, name),
  FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE
);

-- One row per encoded rendition. Populated by the upload + transcode
-- pipeline (Stream callback in Phase 2; ffmpeg-CI for >4K and packed-
-- alpha variants in the Phase 4-5 "Layered visualisation" follow-on).
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
  created_at     TEXT NOT NULL,
  PRIMARY KEY (dataset_id, rendition_id),
  FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE
);

CREATE INDEX idx_renditions_dataset ON dataset_renditions(dataset_id);

CREATE TABLE dataset_related (
  dataset_id     TEXT NOT NULL,
  related_title  TEXT NOT NULL,
  related_url    TEXT NOT NULL,
  PRIMARY KEY (dataset_id, related_url),
  FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE
);

-- Tours owned by this node.
CREATE TABLE tours (
  id                 TEXT PRIMARY KEY,
  slug               TEXT NOT NULL UNIQUE,
  origin_node        TEXT NOT NULL,
  title              TEXT NOT NULL,
  description        TEXT,
  tour_json_ref      TEXT NOT NULL,           -- r2:<key>
  thumbnail_ref      TEXT,
  visibility         TEXT NOT NULL DEFAULT 'public',
  schema_version     INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  published_at       TEXT,
  publisher_id       TEXT,
  FOREIGN KEY (publisher_id) REFERENCES publishers(id)
);

-- Datasets a tour depends on, so a subscriber can resolve ahead of play.
CREATE TABLE tour_dataset_refs (
  tour_id    TEXT NOT NULL,
  dataset_id TEXT NOT NULL,                   -- may be a remote id like "peer:<peer_id>:<id>"
  PRIMARY KEY (tour_id, dataset_id),
  FOREIGN KEY (tour_id) REFERENCES tours(id) ON DELETE CASCADE
);
```

## Federation tables

```sql
-- Outbound: peers this node has subscribed to.
CREATE TABLE federation_peers (
  id                 TEXT PRIMARY KEY,        -- remote node_id
  base_url           TEXT NOT NULL UNIQUE,
  display_name       TEXT,
  public_key         TEXT NOT NULL,           -- pinned at handshake
  shared_secret      TEXT,                    -- HMAC, encrypted at rest
  status             TEXT NOT NULL,           -- pending | active | paused | blocked
  policy             TEXT NOT NULL DEFAULT 'mirror_public',
                                              -- mirror_public | mirror_granted | mirror_all
  last_sync_at       TEXT,
  last_sync_cursor   TEXT,
  last_sync_error    TEXT,
  created_at         TEXT NOT NULL
);

-- Frozen snapshots of remote datasets. Same shape as `datasets` minus
-- publisher_id. Foreign-key isolation from local tables is intentional —
-- no joins between local and federated, ever.
CREATE TABLE federated_datasets (
  peer_id        TEXT NOT NULL,
  remote_id      TEXT NOT NULL,
  origin_node    TEXT NOT NULL,
  payload_json   TEXT NOT NULL,               -- full Dataset object as fetched
  signature      TEXT NOT NULL,               -- Ed25519 over payload_json
  fetched_at     TEXT NOT NULL,
  expires_at     TEXT,
  PRIMARY KEY (peer_id, remote_id),
  FOREIGN KEY (peer_id) REFERENCES federation_peers(id) ON DELETE CASCADE
);

CREATE TABLE federated_tours (
  peer_id        TEXT NOT NULL,
  remote_id      TEXT NOT NULL,
  origin_node    TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  signature      TEXT NOT NULL,
  fetched_at     TEXT NOT NULL,
  expires_at     TEXT,
  PRIMARY KEY (peer_id, remote_id),
  FOREIGN KEY (peer_id) REFERENCES federation_peers(id) ON DELETE CASCADE
);

-- Inbound: peers that have subscribed to *us*.
-- Used to enforce per-dataset grants and to fan out invalidations.
CREATE TABLE federation_subscribers (
  id                 TEXT PRIMARY KEY,
  base_url           TEXT NOT NULL UNIQUE,
  display_name       TEXT,
  public_key         TEXT NOT NULL,
  shared_secret      TEXT,
  status             TEXT NOT NULL,           -- pending | active | paused | blocked
  approved_at        TEXT,
  created_at         TEXT NOT NULL
);
```

## Publishing & access tables

```sql
-- Publisher accounts. Identified by Cloudflare Access email today;
-- (Phase 3+) extend with an OIDC subject for community publishers.
CREATE TABLE publishers (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL,
  affiliation     TEXT,
  role            TEXT NOT NULL,              -- staff | community | readonly
  status          TEXT NOT NULL,              -- pending | active | suspended
  created_at      TEXT NOT NULL
);

-- Per-dataset, per-peer share grants. Phase 3.
-- A row here means: grantee X is allowed to see dataset Y.
CREATE TABLE dataset_grants (
  dataset_id   TEXT NOT NULL,
  grantee_kind TEXT NOT NULL,                 -- 'peer' | 'all_federated' | 'public'
  grantee_id   TEXT,                          -- federation_subscribers.id, or NULL
  expires_at   TEXT,
  granted_by   TEXT NOT NULL,                 -- publishers.id
  granted_at   TEXT NOT NULL,
  PRIMARY KEY (dataset_id, grantee_kind, grantee_id),
  FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE
);

-- Append-only audit log. Every publish, retract, grant, revoke,
-- subscription accept, and ingest webhook lands here.
CREATE TABLE audit_events (
  id              TEXT PRIMARY KEY,           -- ULID
  actor_kind      TEXT NOT NULL,              -- publisher | peer | system
  actor_id        TEXT,
  action          TEXT NOT NULL,
  subject_kind   TEXT NOT NULL,               -- dataset | tour | peer | grant
  subject_id     TEXT,
  metadata_json  TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX idx_audit_subject ON audit_events(subject_kind, subject_id, created_at);
```

## Migration from the existing public catalog

A Phase-1 importer reads
`https://s3.dualstack.us-east-1.amazonaws.com/metadata.sosexplorer.gov/dataset.json`
plus `public/assets/sos_dataset_metadata.json`, runs the same merge
that `dataService.ts` does today, and inserts every record as a
`datasets` row owned by the deploying node with `visibility='public'`.
Vimeo links are preserved verbatim in `data_ref` as `vimeo:<id>` and
resolved by the manifest endpoint (see
[`CATALOG_ASSETS_PIPELINE.md`](CATALOG_ASSETS_PIPELINE.md)), so
cutover doesn't require uploading anything to Stream on day one.
