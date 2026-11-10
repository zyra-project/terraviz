-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 The Zyra Project

-- 0062_catalog_snapshot_generation.sql — a counter that says whether
-- the cached public catalog is still current.
--
-- `GET /api/v1/catalog` serves a body rendered once and cached in KV
-- (`functions/api/v1/_lib/snapshot.ts`). Until this table, the only
-- thing that ever retired that body was a KV delete issued by the
-- publisher write paths, and a delete that failed was swallowed. A KV
-- outage during a retraction therefore left the retracted dataset in
-- the cached body, served again once KV recovered, until some later
-- write happened to invalidate it.
--
-- D1 is where the write itself lands, so the counter lives here:
--   - Every snapshot invalidation adds 1, after the data write it
--     follows.
--   - Every cached body records the generation it was rendered under,
--     read before the render reads any data.
--   - The catalog serves a cached body only when that recorded
--     generation is the current one. Anything else is a miss.
-- A body left behind by a failed KV delete, or put by a render that
-- raced a retraction, is then never served, whatever KV does.
--
-- Singleton by construction, like `node_settings` (0037): `id` is
-- pinned to 1, and the bump is an upsert on id = 1, so it creates the
-- row on a database this INSERT never ran on. A missing row reads as
-- generation 0. Additive only; code deployed before this migration
-- applies logs an error and falls back to the KV entry's TTL.

CREATE TABLE catalog_snapshot_generation (
  id         INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton row
  -- No trailing comment here: SQLite's ALTER ... ADD COLUMN splices
  -- new columns onto the last column-def line (see 0028's note).
  generation INTEGER NOT NULL DEFAULT 0
);

INSERT INTO catalog_snapshot_generation (id, generation) VALUES (1, 0);
