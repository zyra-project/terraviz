-- 0022_analytics_phase_e_rollups.sql — Phase E coverage rollups
-- (docs/ANALYTICS_STORAGE_AND_ADMIN_PLAN.md). Closes the remaining
-- Grafana → /publish/analytics parity gaps: performance, Orbit cost,
-- tour-quiz outcomes, and the long tail of Tier-B / minor mixes.
--
-- Same conventions as 0019–0021: counts are sample-weighted REALs,
-- external traffic only (the export filters internal), idempotent via
-- the export's delete-day-then-insert batch.

-- Performance (Tier A) — from perf_sample. One row per
-- (day, environment, surface, renderer-hash); the dashboard divides
-- the weighted sums by sample counts for averages. jsheap is tracked
-- separately because non-Chromium browsers report 0 (unsupported) and
-- must be excluded from the heap average rather than dragging it down.
CREATE TABLE analytics_perf_daily (
  day            TEXT NOT NULL,            -- 'YYYY-MM-DD' (UTC)
  environment    TEXT NOT NULL,
  surface        TEXT NOT NULL,            -- map | vr
  renderer       TEXT NOT NULL,            -- webgl_renderer_hash (8 hex or 'unknown')
  samples        REAL NOT NULL,            -- sample-weighted perf_sample count
  fps_sum        REAL NOT NULL,            -- Σ fps_median_10s · weight
  frame_p95_sum  REAL NOT NULL,            -- Σ frame_time_p95_ms · weight
  jsheap_sum     REAL NOT NULL,            -- Σ jsheap_mb · weight (only rows > 0)
  jsheap_samples REAL NOT NULL,            -- weight of rows with jsheap_mb > 0
  PRIMARY KEY (day, environment, surface, renderer)
);

CREATE INDEX idx_analytics_perf_daily_day
  ON analytics_perf_daily (environment, day);

-- Orbit cost (Tier B) — from orbit_turn, assistant side only (the
-- user-side turn would double-count). One row per (day, environment,
-- model). The free-tier-neuron early-warning surface; sparse unless
-- users opt into Research mode.
CREATE TABLE analytics_orbit_daily (
  day              TEXT NOT NULL,
  environment      TEXT NOT NULL,
  model            TEXT NOT NULL,
  turns            REAL NOT NULL,          -- sample-weighted assistant turns
  rounds_sum       REAL NOT NULL,          -- Σ turn_rounds · weight (LLM round-trips)
  input_tokens_sum  REAL NOT NULL,
  output_tokens_sum REAL NOT NULL,
  duration_ms_sum  REAL NOT NULL,
  PRIMARY KEY (day, environment, model)
);

CREATE INDEX idx_analytics_orbit_daily_day
  ON analytics_orbit_daily (environment, day);

-- Tour quiz (Tier B) — from tour_question_answered. One row per
-- (day, environment, tour_id, question_id); worst-answered questions
-- are those with the lowest correct/answered ratio.
CREATE TABLE analytics_quiz_daily (
  day             TEXT NOT NULL,
  environment     TEXT NOT NULL,
  tour_id         TEXT NOT NULL,
  question_id     TEXT NOT NULL,
  answered        REAL NOT NULL,           -- sample-weighted answers
  correct         REAL NOT NULL,           -- of which were correct
  response_ms_sum REAL NOT NULL,           -- Σ response_ms · weight
  PRIMARY KEY (day, environment, tour_id, question_id)
);

CREATE INDEX idx_analytics_quiz_daily_day
  ON analytics_quiz_daily (environment, day);

-- Generic dimension rollup — one shape for every simple
-- count[+value-sum]-by-key mix, discriminated by `metric`:
--   search          key=query_hash         value_sum=Σ query_length
--   search_zero     key=query_hash         (rows with result_count_bucket='0')
--   dwell           key=view_target        value_sum=Σ duration_ms   (Tier B)
--   vr_gesture      key=gesture            value_sum=Σ magnitude      (Tier B)
--   click_kind      key=hit_kind           (map_click hit-kind mix)
--   os              key=os                 (session_start, sessions by OS)
--   orbit_correction key=signal                                       (Tier B)
--   orbit_follow    key=path               value_sum=Σ latency_ms     (Tier B)
-- New mixes only add a `metric` value — no new table.
CREATE TABLE analytics_dimension_daily (
  day         TEXT NOT NULL,
  environment TEXT NOT NULL,
  metric      TEXT NOT NULL,
  key         TEXT NOT NULL,
  count       REAL NOT NULL,               -- sample-weighted
  value_sum   REAL NOT NULL DEFAULT 0,     -- metric-specific accumulator
  PRIMARY KEY (day, environment, metric, key)
);

CREATE INDEX idx_analytics_dimension_daily_metric
  ON analytics_dimension_daily (environment, metric, day);
