-- Story media for current events (task: story media).
--
-- `image_url` holds the story's own lead image — the RSS/Atom item's
-- enclosure / media:content at ingest, or the article's og:image via
-- the enrichment fallback. http(s)-validated on write AND re-validated
-- on read; NULL when the source carried none. Additive only.

ALTER TABLE current_events ADD COLUMN image_url TEXT;
