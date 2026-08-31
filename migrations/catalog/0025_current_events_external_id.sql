-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 The Zyra Project

-- 0025_current_events_external_id.sql — dedupe key for ingested events
-- (see docs/CURRENT_EVENTS_PLAN.md §9, ingestion).
--
-- A feed connector (e.g. NASA EONET) re-runs on a schedule and re-sees
-- the same events. `external_id` is the feed item's stable id; together
-- with `feed_id` it uniquely identifies an ingested event, so a re-run
-- updates the existing row (refreshing an open event's geometry/dates)
-- instead of creating duplicates. Manually-entered events leave both
-- null and are exempt from the constraint.
--
-- Additive: a new nullable column + a partial unique index.

ALTER TABLE current_events ADD COLUMN external_id TEXT;

CREATE UNIQUE INDEX idx_current_events_feed_external
  ON current_events(feed_id, external_id)
  WHERE feed_id IS NOT NULL AND external_id IS NOT NULL;
