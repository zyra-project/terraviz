-- 0007_featured_datasets.sql — Phase 1b — operator-curated featured list.
--
-- Powers the docent's `list_featured_datasets` LLM tool (per
-- `CATALOG_BACKEND_PLAN.md` "Docent integration"): when the user has
-- not yet expressed intent ("what should I look at?"), the docent
-- has no query for the vector index. The featured-datasets table is
-- the operator's explicit cold-start answer to that question.
--
-- Curation is explicit — no algorithmic guessing, no
-- popularity-from-analytics. The publisher portal's admin UI
-- (Phase 3) populates this table; for Phase 1b the only writers
-- are the publisher API endpoints that ship in this commit.
--
-- The schema mirrors `CATALOG_DATA_MODEL.md` "featured_datasets":
--   - `dataset_id` is the primary key — a dataset is in the list
--     once or not at all.
--   - `position` is an integer ordering knob. Lower = higher in
--     the list. Repeated values within the table are tolerated
--     (the docent breaks ties by `added_at`); the publisher API
--     just doesn't guarantee uniqueness because the operator UI
--     edits one position at a time and a transient duplicate
--     during reorder is fine.
--   - `added_by` references the publisher who added the entry
--     (audit trail; surfaced by the per-dataset history view in
--     Phase 3).
--   - `added_at` is the ISO 8601 stamp at insertion.
--
-- The position-only index is the index the docent's
-- `list_featured_datasets` query reaches for.

CREATE TABLE featured_datasets (
  dataset_id   TEXT PRIMARY KEY,
  position     INTEGER NOT NULL,             -- display order; lower = higher
  added_by     TEXT NOT NULL,                -- publishers.id
  added_at     TEXT NOT NULL,
  FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE,
  FOREIGN KEY (added_by)   REFERENCES publishers(id)
);

CREATE INDEX idx_featured_datasets_position ON featured_datasets(position);
