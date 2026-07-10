-- Per-node disable list for the built-in agency-YouTube channels (task:
-- media suggestion engine — YouTube source).
--
-- The curated agency channels in `youtube-channels.ts` are code
-- constants, so a node can't remove them the way it removes a custom
-- channel (those live in `youtube_channels`). This table records which
-- built-in channel ids a node has switched OFF from the Feeds console —
-- the search proxy excludes them from the effective allowlist and the
-- per-event fan-out (trimming quota / dropping an off-topic agency)
-- without a source edit. Re-enabling is a delete. Additive only.

CREATE TABLE IF NOT EXISTS youtube_channels_disabled (
  channel_id   TEXT PRIMARY KEY,          -- a built-in agency channel id, switched off
  disabled_by  TEXT,                      -- publishers.id (nullable for service)
  created_at   TEXT NOT NULL,
  FOREIGN KEY (disabled_by) REFERENCES publishers(id)
);
