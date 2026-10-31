-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 The Zyra Project

-- 0058_federation_mirror.sql — the subscriber side of the signed feed
-- (metadata Phase 5, step 5).
--
-- Two tables, a reduced form of the ones `docs/CATALOG_DATA_MODEL.md`
-- plans. Columns for later phases (`shared_secret`, `policy`,
-- `asset_proxy_policy`, `include_in_docent`) are left out rather than
-- stored unused: each is an `ADD COLUMN` when the code that reads it
-- lands, and a column nothing reads is a setting an operator can
-- believe is honoured. `federated_tours` and `federation_subscribers`
-- are later still.
--
-- `federation_peers` is one row per node this node pulls from. `id` is
-- the peer's `node_id` and `public_key` its pinned Ed25519 key, both
-- confirmed against the peer's `/.well-known/terraviz.json` when the
-- row is added. Every page pulled is verified against that pinned key;
-- a peer that rotates its key is re-added by an operator, never
-- re-pinned automatically.
--
-- `last_sync_cursor` is the feed cursor of the last page applied, so a
-- failed pull resumes where it stopped. `full_sync_run` is non-NULL
-- while a full sync is in progress (the pull that starts from no cursor
-- and schedules reconciliation of rows the peer no longer lists); it carries
-- the run id stamped on every row that run has seen, and survives
-- across pulls so a full sync larger than one pull's caps still
-- reconciles when it finishes.
--
-- A finished full sync does not delete anything on the spot. The feed
-- holds back rows changed in its last 30 seconds, so a row edited
-- while the full sync ran can be missing from it and still exist.
-- `sweep_run` and `sweep_after` (epoch ms) record the finished run
-- instead, and the rows it did not deliver are dropped by the first
-- complete incremental pull that starts after `sweep_after`, whose
-- feed window covers that settle period. Rows that pull delivers are
-- stamped with `sweep_run` and so survive.
--
-- `sync_lease` and `sync_lease_until` (epoch ms) let one pull at a time
-- write a peer's mirror. A pull takes the lease with a conditional
-- UPDATE, and every write it makes checks that it still holds it, so a
-- second pull, or one whose lease expired, writes nothing.
--
-- No scheduler exists yet, so there is no sync-interval column; it is
-- an `ADD COLUMN` when one lands.
--
-- `federated_datasets` holds the peer's rows as the wire carried them.
-- It is never joined with `datasets`: mirrored rows are the peer's
-- statement, not this node's catalog. `feed_signature` is the
-- `Terraviz-Signature` header of the page that delivered the row,
-- kept as diagnostic metadata, not verifiable evidence: the page and
-- request target are not retained. `seen_run` is the run
-- that last delivered the row, which is what a full sync reconciles on.
--
-- Additive only. No backfill.

CREATE TABLE federation_peers (
  id                    TEXT PRIMARY KEY,
  base_url              TEXT NOT NULL UNIQUE,
  display_name          TEXT,
  public_key            TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('pending', 'active', 'paused', 'blocked')),
  last_sync_at          TEXT,
  last_sync_cursor      TEXT,
  last_sync_error       TEXT,
  full_sync_run         TEXT,
  sweep_run             TEXT,
  sweep_after           INTEGER,
  sync_lease            TEXT,
  sync_lease_until      INTEGER,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE TABLE federated_datasets (
  peer_id         TEXT NOT NULL REFERENCES federation_peers(id) ON DELETE CASCADE,
  remote_id       TEXT NOT NULL,
  origin_node     TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  feed_signature  TEXT NOT NULL,
  seen_run        TEXT NOT NULL,
  fetched_at      TEXT NOT NULL,
  PRIMARY KEY (peer_id, remote_id)
);

-- Every equality column of the feed scan comes before the range, so
-- the scan reads only rows it can return: hidden rows and other
-- nodes' rows are skipped by the index, not read and discarded.
CREATE INDEX idx_datasets_federation_feed ON datasets (visibility, is_hidden, origin_node, updated_at, id);
