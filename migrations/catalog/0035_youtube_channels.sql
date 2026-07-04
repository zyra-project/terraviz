-- Operator-configurable agency-YouTube channel allowlist (task: media
-- suggestion engine — YouTube source).
--
-- The hardcoded curated set in `youtube-channels.ts` covers the
-- science agencies; this table lets a node's publishers extend the
-- allowlist at runtime with their own vetted channels (added by URL in
-- the Feeds console). Keyed by the canonical YouTube channel id
-- (resolved server-side from the pasted URL), which is the safe key —
-- handles/names can be reassigned, ids can't. Single-node D1, so no
-- origin_node column. Additive only.

CREATE TABLE IF NOT EXISTS youtube_channels (
  channel_id    TEXT PRIMARY KEY,          -- canonical UC… id
  channel_name  TEXT NOT NULL,             -- fetched channel title (display)
  added_by      TEXT,                      -- publishers.id (nullable for service)
  created_at    TEXT NOT NULL,
  FOREIGN KEY (added_by) REFERENCES publishers(id)
);
