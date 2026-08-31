-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 The Zyra Project

-- 0010_non_global_metadata.sql — Phase 3d — non-global data fidelity
-- (bounding box, non-Earth body, image orientation).
--
-- Phase 3b restored three SOS fields the Phase 1d import dropped on
-- the floor (`color_table_ref`, `probing_info`, `bounding_variables`).
-- This migration:
--
--   (a) Promotes the `bounding_variables` JSON column to four typed
--       columns `bbox_n` / `bbox_s` / `bbox_w` / `bbox_e` (REAL).
--       The 3b migration described `bounding_variables` as
--       "per-variable data ranges"; on inspection of every SOS row
--       that has it, the actual content is the geographic NSWE
--       bounding box `{ n, s, w, e }` for the dataset's spatial
--       extent. The misleading column name + wrong-shape JSON-text
--       storage made the data invisible to the SPA (no consumer
--       parsed it). Typed columns let the publisher API validate
--       lat/lon ranges and let the SPA project regional data onto
--       the correct portion of the globe in 3e.
--
--   (b) Adds four new columns for SOS metadata still on the
--       "dropped 12" non-goal list from 3b:
--
--         celestial_body  TEXT — Earth / Mars / Moon / Sun / etc.
--                                NULL means Earth (the common case;
--                                20 rows in the snapshot have a
--                                non-Earth body).
--         radius_mi       REAL — non-Earth body radius (paired with
--                                celestial_body for non-Earth datasets).
--         lon_origin      REAL — globe longitude rotation reference
--                                in degrees. NULL means 0 (prime
--                                meridian centered). 12 SOS rows
--                                use ±180 (dateline-centered) for
--                                Pacific-focused datasets.
--         is_flipped_in_y INTEGER — boolean 0/1 for image-orientation
--                                flag. NULL means 0 (no flip). Zero
--                                rows in the current SOS snapshot
--                                use true; persisted for future
--                                publisher use.
--
-- Backfill: every row with non-NULL bounding_variables gets its
-- bbox_* columns populated from the JSON before the legacy column
-- is dropped. The `json_extract` calls cast strings to REAL so the
-- SOS-publisher convention of storing `{n: "90", s: "-90", ...}`
-- (string-valued numerics) round-trips correctly.
--
-- After this migration the `bounding_variables` column no longer
-- exists; consumers MUST read the typed columns. The Phase 3d
-- importer (3d/B) populates the typed columns directly on every
-- future SOS import; the publisher API (3d/D) accepts a typed
-- `bounding_box: { n, s, w, e }` field on draft / update bodies.
--
-- No new indexes — these columns are read with the row, never
-- queried independently. (A future "datasets in this region"
-- spatial filter would benefit from an R-tree, but that's a
-- federation-era concern; the current row count makes a table
-- scan over `WHERE bbox_n IS NOT NULL` essentially free.)

ALTER TABLE datasets ADD COLUMN bbox_n REAL;
ALTER TABLE datasets ADD COLUMN bbox_s REAL;
ALTER TABLE datasets ADD COLUMN bbox_w REAL;
ALTER TABLE datasets ADD COLUMN bbox_e REAL;
ALTER TABLE datasets ADD COLUMN celestial_body TEXT;
ALTER TABLE datasets ADD COLUMN radius_mi REAL;
ALTER TABLE datasets ADD COLUMN lon_origin REAL;
ALTER TABLE datasets ADD COLUMN is_flipped_in_y INTEGER;

-- Backfill typed bbox from the legacy JSON column. CAST(... AS REAL)
-- handles the SOS-snapshot convention of string-valued numerics
-- ({"n": "90", ...}); D1's JSON1 extension is on by default.
UPDATE datasets
   SET bbox_n = CAST(json_extract(bounding_variables, '$.n') AS REAL),
       bbox_s = CAST(json_extract(bounding_variables, '$.s') AS REAL),
       bbox_w = CAST(json_extract(bounding_variables, '$.w') AS REAL),
       bbox_e = CAST(json_extract(bounding_variables, '$.e') AS REAL)
 WHERE bounding_variables IS NOT NULL
   AND json_extract(bounding_variables, '$.n') IS NOT NULL
   AND json_extract(bounding_variables, '$.s') IS NOT NULL
   AND json_extract(bounding_variables, '$.w') IS NOT NULL
   AND json_extract(bounding_variables, '$.e') IS NOT NULL;

-- destructive: reviewed — drops `bounding_variables` after the
-- backfill above copies its contents into the new bbox_* columns.
-- Grandfathered for the auto-apply additive lint
-- (scripts/check-migrations-additive.ts); this migration shipped and
-- applied before the lint existed, and the column drop is intentional
-- and post-backfill.
ALTER TABLE datasets DROP COLUMN bounding_variables;
