-- 0026_feed_connectors.sql — node-configurable current-events feed
-- registry (docs/CURRENT_EVENTS_PLAN.md §9, the Phase-3 feed console).
--
-- Until now the one events connector (NASA EONET) was hardcoded in the
-- refresh route / import CLI. This table makes the set of feeds a node
-- ingests an operator decision: each row is one connector — which
-- implementation (`kind`) reads it, where it lives (`url`), how the
-- portal groups it (`category`), and whether it currently runs
-- (`enabled`). The publisher portal's feeds page (a later slice) does
-- CRUD over these rows; the refresh route and the scheduled importer
-- iterate the enabled ones.
--
-- `kind` names the connector implementation, not the feed: 'eonet'
-- (the existing GeoJSON mapper) today; 'rss' (the generic RSS/Atom
-- mapper that also powers bring-your-own-feed) lands next. Rows with a
-- kind this deployment doesn't know are skipped with a recorded error
-- rather than failing the run — forward-compatible with connectors
-- added later.
--
-- Run bookkeeping (`last_run_*`) is deliberately one-row-deep: the
-- portal needs "when did this last run and did it work", not a history
-- table. Full run history can layer on later without touching this.
--
-- Seeds the EONET connector this node already ingests, so cutting the
-- routes over from the hardcoded URL to the registry is
-- behavior-preserving: same feed, same cadence, now just read from D1.
-- The fixed id keeps the seed idempotent and recognisable in audits.
--
-- Additive only: a new table + index + seed row, no changes to
-- existing objects.

CREATE TABLE feed_connectors (
  id TEXT PRIMARY KEY,                -- ULID for operator-added rows; fixed id for seeds
  kind TEXT NOT NULL,                 -- connector implementation: 'eonet' | 'rss' (later)
  label TEXT NOT NULL,                -- operator-facing display name
  url TEXT NOT NULL,                  -- the feed endpoint the connector fetches
  category TEXT,                      -- portal grouping ('hazards', 'science-news', 'news', …)
  enabled INTEGER NOT NULL DEFAULT 1, -- 0 = paused; disabled rows are skipped by every run
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_run_at TEXT,                   -- ISO timestamp of the most recent run attempt
  last_run_status TEXT,               -- 'ok' | 'error' (null until first run)
  last_run_error TEXT                 -- human-readable failure detail when status = 'error'
);

CREATE INDEX idx_feed_connectors_enabled ON feed_connectors(enabled);

INSERT INTO feed_connectors (id, kind, label, url, category, enabled, created_at, updated_at)
VALUES (
  'FEED_EONET_DEFAULT',
  'eonet',
  'NASA EONET',
  'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=14',
  'hazards',
  1,
  '2026-07-02T00:00:00.000Z',
  '2026-07-02T00:00:00.000Z'
);
