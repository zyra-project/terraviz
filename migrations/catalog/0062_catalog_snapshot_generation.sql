-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 The Zyra Project

-- 0062_catalog_snapshot_generation.sql — a token that says whether the
-- cached public catalog is still current.
--
-- `GET /api/v1/catalog` serves a body rendered once and cached in KV
-- (`functions/api/v1/_lib/snapshot.ts`). Until this table, the only
-- thing that ever retired that body was a KV delete issued by the
-- publisher write paths, and a delete that failed was swallowed. A KV
-- outage during a retraction therefore left the retracted dataset in
-- the cached body, served again once KV recovered, until some later
-- write happened to invalidate it.
--
-- D1 is where the write itself lands, so the check lives here:
--   - Every snapshot invalidation replaces `generation` with a new
--     random token, after the data write it follows.
--   - Every cached body records the generation it was rendered under,
--     read before the render reads any data.
--   - The catalog serves a cached body only when that recorded
--     generation is the current one. Anything else is a miss.
-- A body left behind by a failed KV delete, or put by a render that
-- raced a retraction, is then never served, whatever KV does.
--
-- A random token rather than a counter, so a value never comes back: a
-- counter rolled back by a D1 restore, or restarted by a recreated
-- database, would count up again to stamps still cached in KV.
--
-- Singleton by construction, like `node_settings` (0037): `id` is
-- pinned to 1, and the replacement is an upsert on id = 1, so it
-- recreates a deleted row. Additive only; code deployed before this
-- migration applies logs an error naming it, and serves only what the
-- KV entry's TTL bounds (see snapshot.ts).

CREATE TABLE catalog_snapshot_generation (
  id         INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton row
  -- No trailing comment here: SQLite's ALTER ... ADD COLUMN splices
  -- new columns onto the last column-def line (see 0028's note).
  generation TEXT NOT NULL
);

INSERT INTO catalog_snapshot_generation (id, generation)
  VALUES (1, lower(hex(randomblob(16))));
