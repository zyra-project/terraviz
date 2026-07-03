-- 0028_node_profile.sql — Phase 3d — the node / host-organization
-- profile (`docs/CURRENT_EVENTS_PLAN.md` §7 companion work;
-- `docs/CATALOG_PUBLISHING_TOOLS.md`).
--
-- A TerraViz node is run by a host organization (a science museum, a
-- university lab, an agency outreach team). This singleton row is the
-- operator-authored "about the host" context that AI-assisted
-- generation grounds itself in — the Phase 3d blog generator reads it
-- so a draft can speak in the node's own voice about its own mission —
-- and it is deliberately generic enough to back other surfaces later
-- (an about page, footer attribution).
--
-- Singleton by construction, mirroring `hero_override` (0017):
--   - `id` pinned to 1 by a CHECK constraint; "set" is an upsert on
--     id = 1. Absence of a row means "profile not filled in yet" and
--     every consumer must degrade gracefully.
--
-- Columns are operator prose, not machine config:
--   - `org_name`      — the host organization's display name.
--   - `mission`       — one-to-three-sentence mission statement.
--   - `about_md`      — longer free-form background (markdown).
--   - `region_focus`  — optional geographic focus, free text
--                       (e.g. "Gulf of Mexico coast").
--   - `default_tone`  — optional authoring-tone hint for generated
--                       drafts (e.g. "educational, general public").
--   - `links_json`    — optional JSON array of {label, url} the node
--                       wants surfaced alongside its identity.
--   - `updated_by` / `updated_at` — audit trail of the last edit.

CREATE TABLE node_profile (
  id           INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton row
  org_name     TEXT NOT NULL,
  mission      TEXT,
  about_md     TEXT,
  region_focus TEXT,
  default_tone TEXT,
  links_json   TEXT,                     -- JSON array of {label, url}
  updated_by   TEXT NOT NULL,            -- publishers.id (audit)
  -- ISO 8601. No trailing comment here: SQLite's ALTER ... ADD COLUMN
  -- splices new columns onto the last column-def line of the stored
  -- CREATE TABLE text, and a trailing comment would read as if it
  -- documented the appended column (see 0024's reviewed_by).
  updated_at   TEXT NOT NULL,
  FOREIGN KEY (updated_by) REFERENCES publishers(id)
);
