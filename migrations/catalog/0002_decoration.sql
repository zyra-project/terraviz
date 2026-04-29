-- 0002_decoration.sql — Phase 1a — many-to-many decoration tables.
--
-- Each table is keyed by dataset_id with ON DELETE CASCADE so a
-- retracted-and-purged dataset cleans up after itself. On the wire,
-- categories collapse to a per-facet array and tags / keywords to
-- flat arrays; the decoration tables never join into a single
-- denormalized response.

CREATE TABLE dataset_tags (
  dataset_id  TEXT NOT NULL,
  tag         TEXT NOT NULL,
  PRIMARY KEY (dataset_id, tag),
  FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE
);

CREATE TABLE dataset_categories (
  dataset_id  TEXT NOT NULL,
  facet       TEXT NOT NULL,                  -- e.g., "Theme", "Region"
  value       TEXT NOT NULL,
  PRIMARY KEY (dataset_id, facet, value),
  FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE
);

CREATE TABLE dataset_keywords (
  dataset_id  TEXT NOT NULL,
  keyword     TEXT NOT NULL,
  PRIMARY KEY (dataset_id, keyword),
  FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE
);

CREATE TABLE dataset_developers (
  dataset_id      TEXT NOT NULL,
  role            TEXT NOT NULL,              -- 'data' | 'visualization'
  name            TEXT NOT NULL,
  affiliation_url TEXT,
  PRIMARY KEY (dataset_id, role, name),
  FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE
);

CREATE TABLE dataset_related (
  dataset_id     TEXT NOT NULL,
  related_title  TEXT NOT NULL,
  related_url    TEXT NOT NULL,
  PRIMARY KEY (dataset_id, related_url),
  FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE
);
