-- 0004_tours.sql — Phase 1a — tours + tour_dataset_refs.
--
-- Tours are stored as references to JSON blobs in R2 (or, in
-- Phase 1a's pre-R2 reality, as inline tour/json data_refs on the
-- corresponding datasets row — the seed importer treats SOS tours
-- as datasets with format='tour/json' and does not populate this
-- table). The dedicated tours table comes online when the publisher
-- portal's tour creator lands in Phase 3.
--
-- tour_dataset_refs is the dependency edge a subscriber needs to
-- resolve datasets ahead of tour playback. dataset_id may be a
-- remote handle like "peer:<peer_id>:<id>" once federation is live;
-- in Phase 1a the column only ever holds local ULIDs.

CREATE TABLE tours (
  id                 TEXT PRIMARY KEY,
  slug               TEXT NOT NULL UNIQUE,
  origin_node        TEXT NOT NULL,
  title              TEXT NOT NULL,
  description        TEXT,
  tour_json_ref      TEXT NOT NULL,           -- r2:<key>
  thumbnail_ref      TEXT,
  visibility         TEXT NOT NULL DEFAULT 'public',
  schema_version     INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  published_at       TEXT,
  publisher_id       TEXT,
  FOREIGN KEY (publisher_id) REFERENCES publishers(id)
);

CREATE TABLE tour_dataset_refs (
  tour_id    TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  PRIMARY KEY (tour_id, dataset_id),
  FOREIGN KEY (tour_id) REFERENCES tours(id) ON DELETE CASCADE
);
