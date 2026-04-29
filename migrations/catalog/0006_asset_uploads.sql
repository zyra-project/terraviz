-- 0006_asset_uploads.sql — Phase 1b — pending asset-upload tracking.
--
-- Tracks the lifecycle of every browser/CLI upload from "we minted a
-- presigned PUT or a Stream direct-upload URL" through "the publisher
-- says they finished, here's the digest" to "we read the bytes back,
-- recomputed the digest, and either flipped the dataset row or
-- recorded the failure."
--
-- Distinct from `dataset_renditions` (0003) — that tracks completed
-- video renditions for manifest selection, which is a different
-- shape and lifecycle. Keeping the two tables separate avoids
-- mixing in-flight upload bookkeeping with the long-lived rendition
-- catalog the federation feed depends on.
--
-- Lifecycle states:
--   - `pending`   — URL minted; bytes not yet uploaded.
--   - `completed` — bytes uploaded, digest verified, dataset row's
--                   `*_ref` column flipped.
--   - `failed`    — digest mismatch, expired URL, or Stream
--                   transcode error. `failure_reason` carries a
--                   short machine-readable code so the publisher
--                   portal / CLI can surface the right message.
--
-- The row is *append-only on identity*: an `id` never moves states
-- in reverse, and the publisher must mint a fresh upload to retry
-- after a failure. That keeps audit reasoning straightforward — a
-- given (dataset_id, kind, completed_at) tuple uniquely identifies
-- the bytes that won, and previous failed attempts are visible
-- alongside without a separate history table.
--
-- `target_ref` is the storage-side reference: `r2:<key>` for R2
-- uploads, `stream:<uid>` for Stream uploads. The complete-handler
-- in Commit D copies this onto the `datasets` row's appropriate
-- `*_ref` column on success.

CREATE TABLE asset_uploads (
  id              TEXT PRIMARY KEY,           -- ULID
  dataset_id      TEXT NOT NULL,
  publisher_id    TEXT NOT NULL,              -- who minted the URL
  kind            TEXT NOT NULL,              -- data | thumbnail | legend | caption | sphere_thumbnail
  target          TEXT NOT NULL,              -- r2 | stream
  target_ref      TEXT NOT NULL,              -- r2:<key> | stream:<uid>
  mime            TEXT NOT NULL,
  declared_size   INTEGER NOT NULL,
  claimed_digest  TEXT NOT NULL,              -- "sha256:<hex>"
  status          TEXT NOT NULL,              -- pending | completed | failed
  failure_reason  TEXT,                       -- machine-readable code; NULL when status != failed
  created_at      TEXT NOT NULL,
  completed_at    TEXT,                       -- stamped on completed | failed
  FOREIGN KEY (dataset_id)   REFERENCES datasets(id) ON DELETE CASCADE,
  FOREIGN KEY (publisher_id) REFERENCES publishers(id)
);

-- "List in-flight uploads for a dataset" — used by the publisher
-- portal to show pending / failed retries inline.
CREATE INDEX idx_asset_uploads_dataset ON asset_uploads(dataset_id, created_at);
