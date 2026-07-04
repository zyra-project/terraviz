-- Video embed for current events (task: media suggestion engine —
-- agency YouTube source).
--
-- `video_embed_url` holds a curator-picked video EMBED url (a
-- `youtube-nocookie.com/embed/{id}` URL), kept separate from
-- `image_url` because a video can't be a story image: YouTube's ToS
-- forbids restoring its thumbnails as node content, and the value is
-- an iframe src, not an <img src>. The auto-generated companion tour
-- frames it as a media-rail embed. http(s)/host-validated on write;
-- NULL when the curator picked no video. Additive only.

ALTER TABLE current_events ADD COLUMN video_embed_url TEXT;
