-- 0020_analytics_errors_rollup.sql — error-breakdown rollup for the
-- /publish/analytics Overview section (Phase B follow-up of
-- docs/ANALYTICS_STORAGE_AND_ADMIN_PLAN.md).
--
-- The daily rollup (0019) stores error *counts* only; this table
-- keeps the breakdown dimensions so the dashboard's errors tile can
-- expand into a frequency-ordered table that outlives AE retention.
-- One row per (day, environment, category, source, code,
-- message_class); external traffic only, same posture as the
-- dataset/spatial rollups. `message_class` is the client-sanitized
-- first line (URLs/emails/digit-runs stripped, ≤80 chars at emit) —
-- safe to persist.
--
-- Counts are REAL: sample-weighted estimates, same convention as
-- every other rollup. The export job's delete-day-then-insert batch
-- keeps re-exports idempotent.
CREATE TABLE analytics_errors_daily (
  day           TEXT NOT NULL,             -- 'YYYY-MM-DD' (UTC)
  environment   TEXT NOT NULL,             -- production | preview | local
  category      TEXT NOT NULL,             -- tile | hls | llm | vr | uncaught | …
  source        TEXT NOT NULL,             -- caught | window_error | …
  code          TEXT NOT NULL,             -- HTTP status or classified enum
  message_class TEXT NOT NULL,             -- sanitized first line
  count         REAL NOT NULL,             -- sample-weighted
  PRIMARY KEY (day, environment, category, source, code, message_class)
);

CREATE INDEX idx_analytics_errors_daily_day
  ON analytics_errors_daily (environment, day);
