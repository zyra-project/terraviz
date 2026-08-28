-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 The Zyra Project

-- Direct-file video for current events (task: video-sitemap media
-- source). Sibling of `video_embed_url` (migration 0034), which holds a
-- YouTube nocookie EMBED url rendered as an iframe. `video_file_url`
-- holds a curator-picked DIRECT media file (e.g. a NOAA Ocean Today
-- MP4) rendered as a native <video> — kept separate because the two
-- flow through different guards and different tour tasks: the embed url
-- is nocookie-host-locked and framed as `showPopupHtml`; the file url is
-- validated against the registered video-source host allowlist and
-- played as `playVideo`. NULL when the curator picked no direct video.
-- Additive only.

ALTER TABLE current_events ADD COLUMN video_file_url TEXT;
