-- 0037_node_settings.sql — per-node feature toggles.
--
-- A TerraViz node doesn't have to run every feature: a museum may
-- want a simplified datasets-only catalog with no newsroom, while a
-- commentary/syndication node may want the opposite. This singleton
-- row stores the operator's feature toggles (events / blog / hero /
-- tours / workflows / analytics / feedback / datasets) that gate the
-- publisher portal tabs, the publisher API (centrally, in the
-- `/publish` middleware), and the public newsroom surfaces.
--
-- Deliberately its own table rather than a column on `node_profile`:
-- the profile PUT is a full-column upsert that requires `org_name`,
-- so riding on it would couple toggle saves to profile-form saves
-- and block toggles on an unfilled profile.
--
-- Singleton by construction, mirroring `node_profile` (0028):
--   - `id` pinned to 1 by a CHECK constraint; "set" is an upsert on
--     id = 1. Absence of a row means "never configured" = every
--     feature enabled. Writes store the complete normalized map
--     (every key, so the row is self-describing); reads still
--     normalize defensively — missing/unknown keys resolve to
--     enabled — see `src/types/node-features.ts`
--     (`normalizeFeatures`).
--   - `updated_by` / `updated_at` — audit trail of the last edit
--     (full history in `audit_events` as `node_settings.update`).

CREATE TABLE node_settings (
  id            INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton row
  features_json TEXT NOT NULL DEFAULT '{}',  -- JSON object of {feature: boolean}
  updated_by    TEXT NOT NULL,               -- publishers.id (audit)
  -- ISO 8601. No trailing comment here: SQLite's ALTER ... ADD COLUMN
  -- splices new columns onto the last column-def line of the stored
  -- CREATE TABLE text (see 0028's note).
  updated_at    TEXT NOT NULL,
  FOREIGN KEY (updated_by) REFERENCES publishers(id)
);
