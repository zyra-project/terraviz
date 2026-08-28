-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 The Zyra Project

-- Cover image for blog posts (task: blog suggested media).
--
-- `cover_image_url` holds the post's own lead image — a curator pick
-- from the blog editor's Media tab (NASA Worldview snapshot, a
-- public-domain Wikimedia Commons photo, a USGS ShakeMap, an NHC
-- forecast cone, or the cited event's vetted story image).
-- http(s)-validated on write AND re-validated on read; NULL when the
-- curator set none (the public page then falls back to the cited
-- event's image, as before). `cover_image_alt` is its alt text (media
-- accessibility). Additive only.

ALTER TABLE blog_posts ADD COLUMN cover_image_url TEXT;
ALTER TABLE blog_posts ADD COLUMN cover_image_alt TEXT;
