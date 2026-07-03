-- 0029_blog_posts.sql — Phase 3d — curator-authored blog posts
-- (`docs/CURRENT_EVENTS_PLAN.md` §7 companion work).
--
-- The publishing side of the AI draft-and-publish loop: a curator
-- selects datasets (and optionally a cited current event), the
-- generator drafts a markdown post grounded in the node profile
-- (0028), the curator edits, and publishing flips `status` — nothing
-- auto-publishes, same trust discipline as events and tours.
--
--   - `id` is a ULID; `slug` is the public URL segment, unique,
--     allocated once at create and stable thereafter (published
--     URLs must not churn on a title edit).
--   - `body_md` is the post itself (markdown; rendered through the
--     shared sanitized pipeline client-side).
--   - `dataset_ids` is a JSON array of the dataset ids the post
--     cites — the "explore the data" affordance on the public page.
--   - `event_id` optionally cites the current event that prompted
--     the post. ON DELETE SET NULL: deleting an event must not take
--     a published post down with it.
--   - `status` is 'draft' | 'published'. Unpublish returns to
--     'draft'; the audit log carries the history.
--   - `author_id` / timestamps are the audit trail.

CREATE TABLE blog_posts (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  summary      TEXT,                     -- optional standfirst under the title
  body_md      TEXT NOT NULL,
  dataset_ids  TEXT,                     -- JSON array of datasets.id
  event_id     TEXT,                     -- optional cited current_events.id
  author_id    TEXT NOT NULL,            -- publishers.id
  status       TEXT NOT NULL DEFAULT 'draft',
  created_at   TEXT NOT NULL,            -- ISO 8601
  updated_at   TEXT NOT NULL,            -- ISO 8601
  published_at TEXT,                     -- ISO 8601; set on publish
  FOREIGN KEY (author_id) REFERENCES publishers(id),
  FOREIGN KEY (event_id)  REFERENCES current_events(id) ON DELETE SET NULL
);

-- Composite: the public list filters status = 'published' AND orders
-- by published_at DESC — this index satisfies both without a sort.
CREATE INDEX idx_blog_posts_status ON blog_posts(status, published_at DESC);
