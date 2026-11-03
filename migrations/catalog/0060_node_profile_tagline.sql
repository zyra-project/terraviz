-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 The Zyra Project

-- Splash-screen tagline for the node profile.
--
-- `tagline` is the short line the public app's loading screen shows
-- under the TerraViz title. NULL (the default, and every existing
-- row) keeps the built-in, translated "Science On a Sphere"; a node
-- run by a named lab sets its own (for example "Global Systems
-- Laboratory"). Operator prose, shown verbatim in every locale.
-- Single line, at most 80 characters — bounded and validated by
-- `functions/api/v1/_lib/node-profile-store.ts`. Additive only.

ALTER TABLE node_profile ADD COLUMN tagline TEXT;
