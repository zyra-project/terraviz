-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 The Zyra Project

-- Alt text for the event story image (task: media suggestion engine;
-- media accessibility).
--
-- `image_alt` is the human-written description of `image_url` —
-- curator-supplied on upload / suggestion pick, NULL for feed images
-- that arrived without one. Cleared whenever the image is replaced
-- without a fresh description so stale text never describes a new
-- image. Additive only.

ALTER TABLE current_events ADD COLUMN image_alt TEXT;
