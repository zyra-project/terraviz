-- 0024_current_events.sql — Current Events ↔ Real-Time Data, data
-- layer (see docs/CURRENT_EVENTS_PLAN.md).
--
-- The first, foundational slice of the current-events feature: storage
-- for reputable current-events records that *annotate* datasets, plus
-- the proposed/approved links between an event and the datasets it
-- relates to. No ingestion, matching, route, or UI lands here — this is
-- the table layer everything else builds on.
--
-- SOURCE-AGNOSTIC BY DESIGN. A node is self-contained and may cover any
-- subject; per the feature's premise, events must relate to *this node's*
-- catalog, not to a hardcoded Earth-science feed. So a row carries only
-- generic provenance (`source_name` / `source_url` / `published_at`) and
-- a `feed_id` discriminator naming whichever connector produced it
-- (null for a manually-entered event). Which feed — if any — a node
-- ingests is a later, node-configurable decision; this schema bakes in
-- no assumption about it.
--
-- Lifecycle mirrors the catalog's curator-gated model: an event (and
-- each event→dataset link) starts `proposed` and is only surfaced to
-- end-users once a curator flips it to `approved`. The `status` columns
-- are the trust gate; window/freshness evaluation lives in application
-- code, not the schema (matching the `hero_override` split in 0017).
--
-- Geometry is stored verbatim — a NSWE bounding box (same convention as
-- `datasets.bbox_*` / `Dataset.boundingBox`), and/or a point, and/or a
-- named region resolved later against `src/data/regions.ts`. Any subset
-- may be null; the matcher (a later slice) decides how to use them.
--
-- Additive only: new tables + indexes, no changes to existing objects.

CREATE TABLE current_events (
  id             TEXT PRIMARY KEY,              -- ULID (newUlid)
  origin_node    TEXT NOT NULL,                 -- node_id, denormalized (federation-ready)

  title          TEXT NOT NULL,
  summary        TEXT,

  -- Provenance — mandatory source attribution (every item is citable).
  source_name    TEXT NOT NULL,                 -- e.g. "NOAA", "USGS"
  source_url     TEXT NOT NULL,                 -- the citation link
  published_at   TEXT,                          -- ISO 8601, when the source published
  feed_id        TEXT,                          -- connector that produced this (null = manual)

  -- The event's own time span (distinct from publish time).
  occurred_start TEXT,                          -- ISO 8601
  occurred_end   TEXT,                          -- ISO 8601 (null = ongoing / instantaneous)

  -- Geometry — any subset may be present.
  bbox_n         REAL,                          -- NSWE box, degrees (cf. datasets.bbox_*)
  bbox_s         REAL,
  bbox_w         REAL,
  bbox_e         REAL,
  point_lat      REAL,
  point_lon      REAL,
  region_name    TEXT,                          -- resolved via regions.ts at match time

  -- Curator gate: proposed | approved | rejected | expired.
  status         TEXT NOT NULL DEFAULT 'proposed',

  created_at     TEXT NOT NULL,                 -- ISO 8601
  updated_at     TEXT NOT NULL,                 -- ISO 8601
  reviewed_at    TEXT,                          -- ISO 8601, when a curator last acted
  reviewed_by    TEXT,                          -- publishers.id (audit), null until reviewed
  FOREIGN KEY (reviewed_by) REFERENCES publishers(id)
);

-- Review-queue scan ("show me proposed events") and federation scoping.
CREATE INDEX idx_current_events_status      ON current_events(status, created_at);
CREATE INDEX idx_current_events_origin_node ON current_events(origin_node);

-- Proposed/approved links between an event and the datasets it relates
-- to. The matcher writes `proposed` rows with a score + a per-signal
-- breakdown; a curator approves them per-link. One row per (event,
-- dataset) pair. CASCADE so deleting either side cleans up its links.
CREATE TABLE event_dataset_links (
  event_id     TEXT NOT NULL,
  dataset_id   TEXT NOT NULL,
  match_score  REAL,                            -- combined matcher score
  signals_json TEXT,                            -- JSON: { geo, temporal, semantic }
  status       TEXT NOT NULL DEFAULT 'proposed', -- proposed | approved | rejected
  created_at   TEXT NOT NULL,                   -- ISO 8601
  approved_at  TEXT,                            -- ISO 8601, null until approved
  approved_by  TEXT,                            -- publishers.id (audit)
  PRIMARY KEY (event_id, dataset_id),
  FOREIGN KEY (event_id)    REFERENCES current_events(id) ON DELETE CASCADE,
  FOREIGN KEY (dataset_id)  REFERENCES datasets(id)       ON DELETE CASCADE,
  FOREIGN KEY (approved_by) REFERENCES publishers(id)
);

-- Reverse lookup: "which approved events relate to this dataset?" — the
-- read path behind the future per-dataset "In the news" panel.
CREATE INDEX idx_event_dataset_links_dataset ON event_dataset_links(dataset_id, status);

-- Decoration tables mirroring dataset_categories / dataset_keywords
-- (0002_decoration.sql), so the later lexical/semantic matcher has a
-- vocabulary to read from. Keyed by event_id, ON DELETE CASCADE.
CREATE TABLE event_categories (
  event_id  TEXT NOT NULL,
  facet     TEXT NOT NULL,                      -- e.g. "Theme", "Region"
  value     TEXT NOT NULL,
  PRIMARY KEY (event_id, facet, value),
  FOREIGN KEY (event_id) REFERENCES current_events(id) ON DELETE CASCADE
);

CREATE TABLE event_keywords (
  event_id  TEXT NOT NULL,
  keyword   TEXT NOT NULL,
  PRIMARY KEY (event_id, keyword),
  FOREIGN KEY (event_id) REFERENCES current_events(id) ON DELETE CASCADE
);
