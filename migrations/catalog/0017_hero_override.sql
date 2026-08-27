-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 The Zyra Project

-- 0017_hero_override.sql — Phase 7 §9.1 — the "Right now" hero
-- override, set from the publisher portal (see
-- docs/HERO_ADMIN_SCOPING.md).
--
-- The catalog homepage shows a single pinned hero card. §9.1 shipped
-- the curator override as a static `public/featured-now.json` file;
-- this table is the operator-writable backing store the publisher
-- portal mutates, read back through `GET /api/v1/featured-hero`. The
-- static file remains the fallback floor for static-only deploys, so
-- this table is additive — absence of a row means "no override, fall
-- through to the file / auto-derive."
--
-- Singleton by construction:
--   - `id` is pinned to 1 by a CHECK constraint, so there is at most
--     one hero. "Set" is an upsert on id = 1; "clear" is a delete.
--     A second insert with a different id is rejected; an insert
--     with id = 1 collides on the PK and the upsert path handles it.
--
-- The activation window is MANDATORY (both columns NOT NULL),
-- enforcing §9.1's "no window ⇒ override ignored, can't silently go
-- stale" invariant at the schema level rather than only in the
-- client. `window_start` / `window_end` are ISO-8601 strings; the
-- client (heroService) evaluates whether `now` falls inside the
-- window — the store just persists the raw bounds.
--
--   - `dataset_id` FKs `datasets(id)` with ON DELETE CASCADE, so
--     retiring the pinned dataset auto-clears a stale hero — no
--     dangling override row.
--   - `headline` is the optional curator headline (the UI falls back
--     to the dataset title when null).
--   - `set_by` / `set_at` are the audit trail: which publisher set
--     the current pin, and when.

CREATE TABLE hero_override (
  id           INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton row
  dataset_id   TEXT NOT NULL,
  window_start TEXT NOT NULL,            -- ISO 8601, mandatory (§9.1)
  window_end   TEXT NOT NULL,            -- ISO 8601, mandatory
  headline     TEXT,                     -- optional curator headline
  set_by       TEXT NOT NULL,            -- publishers.id (audit)
  set_at       TEXT NOT NULL,            -- ISO 8601
  FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE,
  FOREIGN KEY (set_by)     REFERENCES publishers(id)
);
