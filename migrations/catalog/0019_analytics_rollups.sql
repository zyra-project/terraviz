-- 0019_analytics_rollups.sql — Phase A of
-- docs/ANALYTICS_STORAGE_AND_ADMIN_PLAN.md — long-term analytics
-- rollup tables fed by the nightly export job
-- (functions/api/v1/publish/analytics-export.ts).
--
-- Analytics Engine keeps the raw event stream for 30–90 days; these
-- tables keep per-day aggregates indefinitely so the
-- /publish/analytics dashboard (Phase B) can answer historical
-- questions after AE has forgotten the rows. Full-fidelity raw
-- lines land in the `terraviz-analytics` R2 bucket alongside; D1
-- holds only aggregates, so growth is bounded by (days × group
-- cardinality), not by traffic.
--
-- Counts are REAL, not INTEGER, on purpose: AE samples at write
-- time and every count here is `sum(_sample_interval)` — an
-- estimate. Storing floats keeps that honest (the dashboard labels
-- them "estimated").
--
-- `metrics` / `trigger_mix` / `source_mix` are JSON text columns
-- rather than wide nullable column sets: the per-event metric
-- vocabulary will drift as events evolve, and `json_extract()` is
-- cheap in SQLite. The stable grouping dimensions are real columns
-- so they can be indexed and used in PRIMARY KEYs.

-- One row per (day, event_type, environment, internal, country,
-- platform). `platform` is populated from `session_start` events
-- only ('' elsewhere) — it is a session attribute, not an event
-- attribute, and the export job does not attempt a session join.
CREATE TABLE analytics_daily (
  day            TEXT NOT NULL,             -- 'YYYY-MM-DD' (UTC)
  event_type     TEXT NOT NULL,
  environment    TEXT NOT NULL,             -- production | preview | local
  internal       INTEGER NOT NULL,          -- 0 | 1 (Cloudflare Access staff)
  country        TEXT NOT NULL,             -- ISO 3166-1 alpha-2, or 'XX'
  platform       TEXT NOT NULL DEFAULT '',  -- web | desktop | mobile | ''
  events_count   REAL NOT NULL,             -- sample-weighted event count
  sessions_count REAL NOT NULL,             -- distinct session ids seen
  metrics        TEXT NOT NULL DEFAULT '{}',-- JSON: named percentiles etc.
  PRIMARY KEY (day, event_type, environment, internal, country, platform)
);

CREATE INDEX idx_analytics_daily_event
  ON analytics_daily (event_type, day);

-- Dataset-level engagement, one row per (day, layer_id,
-- environment). Feeds the Dataset engagement panels now and the
-- per-publisher analytics surface later (CATALOG_BACKEND_PLAN.md
-- Phase 4). `dwell_ms_sum` comes from `layer_unloaded.dwell_ms`
-- (Tier A — on-globe time), not the Tier B `dwell` panel event.
CREATE TABLE analytics_dataset_daily (
  day          TEXT NOT NULL,
  layer_id     TEXT NOT NULL,
  environment  TEXT NOT NULL,
  loads        REAL NOT NULL,               -- layer_loaded, weighted
  trigger_mix  TEXT NOT NULL DEFAULT '{}',  -- JSON {browse|orbit|tour|url|default: n}
  source_mix   TEXT NOT NULL DEFAULT '{}',  -- JSON {network|cache|hls|image: n}
  load_ms_p50  REAL,                        -- NULL when no samples that day
  load_ms_p95  REAL,
  dwell_ms_sum REAL,                        -- NULL when no unloads that day
  PRIMARY KEY (day, layer_id, environment)
);

CREATE INDEX idx_analytics_dataset_daily_layer
  ON analytics_dataset_daily (layer_id, day);

-- Spatial attention bins for the heatmap panels. 0.5° bins
-- (~55 km at the equator) — comfortably above the 3-decimal
-- (~111 m) rounding applied client-side at emit, and matching the
-- resolution the Grafana spatial dashboards already round to.
-- `layer_id` is '' for the default-Earth view (and for map_click,
-- which carries no dataset context); `projection` is '' for
-- map_click for the same reason.
CREATE TABLE analytics_spatial_daily (
  day         TEXT NOT NULL,
  event_type  TEXT NOT NULL,                -- camera_settled | map_click
  environment TEXT NOT NULL,
  layer_id    TEXT NOT NULL DEFAULT '',
  projection  TEXT NOT NULL DEFAULT '',     -- globe | mercator | vr | ar | ''
  lat_bin     REAL NOT NULL,                -- floor(lat / 0.5) * 0.5
  lon_bin     REAL NOT NULL,
  hits        REAL NOT NULL,                -- sample-weighted
  PRIMARY KEY (day, event_type, environment, layer_id, projection, lat_bin, lon_bin)
);

CREATE INDEX idx_analytics_spatial_daily_layer
  ON analytics_spatial_daily (event_type, layer_id, day);

-- Export bookmark (singleton). `last_day` is the newest fully
-- exported UTC day; the export endpoint walks `last_day + 1` ..
-- yesterday on each tick, so a missed cron run self-heals on the
-- next one and re-runs are idempotent (rollup writes are a
-- delete-the-day-then-insert batch in one D1 transaction; the R2
-- object for a day is simply overwritten).
CREATE TABLE analytics_export_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  last_day   TEXT NOT NULL,                 -- 'YYYY-MM-DD' (UTC)
  updated_at TEXT NOT NULL
);
