-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 The Zyra Project

-- Dataset-browser subtitle for the node profile.
--
-- `browse_subtitle` is the line the public app's dataset browser shows
-- under the Terraviz title. NULL (the default, and every existing row)
-- keeps the built-in, translated "Browse environmental datasets from
-- NOAA Science On a Sphere"; a node sets its own (for example "Browse
-- datasets from NOAA's Global Systems Laboratory"). Operator prose,
-- shown verbatim in every locale. Single line, at most 120 characters,
-- held to the same character rules as 0060's `tagline` — bounded and
-- validated by `functions/api/v1/_lib/node-profile-store.ts`.
-- Additive only.

ALTER TABLE node_profile ADD COLUMN browse_subtitle TEXT;
