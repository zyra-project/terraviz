-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 The Zyra Project

-- 0015_tours_retracted_at.sql — Phase 3pt/G follow-up — add the
-- `retracted_at` column to `tours` so a publisher can take a
-- tour off the public surface without hard-deleting it.
--
-- Mirrors the datasets pattern (0001_init.sql):
--   published_at IS NULL                          → draft
--   published_at IS NOT NULL AND retracted_at IS NULL → published
--   retracted_at IS NOT NULL                      → retracted
--
-- Republishing a retracted tour clears `retracted_at` (see
-- `publishTour` in `tour-mutations.ts`). The immutable R2
-- snapshot from the prior publish stays in place — federation
-- peers may still hold the URL — but the public list /
-- catalog snapshot drops the row until it goes back to
-- published.

ALTER TABLE tours ADD COLUMN retracted_at TEXT;

-- Index the visibility filter the public list will run on every
-- request: "give me public, published, non-retracted tours,
-- newest first." `id < ?` cursor pagination uses the PK index
-- separately. Mirrors `idx_datasets_visibility` from 0001_init.
CREATE INDEX idx_tours_visibility ON tours(visibility, retracted_at, published_at);
