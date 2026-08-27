-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 The Zyra Project

-- 0021_analytics_outcomes_rollup.sql — outcome-dimension rollup for
-- true funnels on /publish/analytics (follow-up to 0019/0020,
-- docs/ANALYTICS_STORAGE_AND_ADMIN_PLAN.md).
--
-- The daily rollup collapses each event type to a count, losing the
-- low-cardinality dimension needed for completion funnels:
-- `tour_ended.outcome` (completed | abandoned | error) and
-- `vr_session_started.mode` (ar | vr). One row per
-- (day, environment, event_type, value); external traffic only,
-- counts are sample-weighted REALs — same conventions as every
-- other rollup, idempotent via the export's delete-day-then-insert.
CREATE TABLE analytics_outcomes_daily (
  day         TEXT NOT NULL,               -- 'YYYY-MM-DD' (UTC)
  environment TEXT NOT NULL,               -- production | preview | local
  event_type  TEXT NOT NULL,               -- tour_ended | vr_session_started
  value       TEXT NOT NULL,               -- the dimension value
  count       REAL NOT NULL,               -- sample-weighted
  PRIMARY KEY (day, environment, event_type, value)
);

CREATE INDEX idx_analytics_outcomes_daily_day
  ON analytics_outcomes_daily (environment, day);
