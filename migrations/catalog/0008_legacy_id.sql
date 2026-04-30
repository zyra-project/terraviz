-- 0008_legacy_id.sql — Phase 1d — provenance + idempotency for SOS bulk import.
--
-- Adds the `legacy_id` column to `datasets`. Phase 1d's bulk
-- importer (`terraviz import-snapshot`) populates it from the SOS
-- snapshot's internal id (e.g. `INTERNAL_SOS_768`) so re-running
-- the import is a no-op on rows already imported. Slug-as-key was
-- considered and rejected: the publisher API auto-suffixes
-- collisions to `-2` / `-3` / …, which makes slug-equality an
-- unsafe identity check across mixed publisher / importer writes.
--
-- After Phase 1d ships, the column also doubles as "imported from
-- SOS" provenance — a future publisher-portal history view
-- (Phase 3) can surface it without another schema change. For
-- publisher-created drafts that were never imported, the column
-- stays NULL.
--
-- Uniqueness is enforced via a unique partial index rather than a
-- column-level UNIQUE so SQLite ALTER TABLE ADD COLUMN can add the
-- column without a table rebuild. The partial WHERE excludes NULLs
-- (publisher-created drafts always pass NULL); SQLite already
-- treats NULLs as non-equal under UNIQUE, but the partial form
-- makes the intent explicit and matches the equivalent Postgres
-- definition for the eventual cloud-portability story.

ALTER TABLE datasets ADD COLUMN legacy_id TEXT;

CREATE UNIQUE INDEX idx_datasets_legacy_id
  ON datasets(legacy_id)
  WHERE legacy_id IS NOT NULL;
