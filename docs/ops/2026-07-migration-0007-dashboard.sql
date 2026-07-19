-- Migration 0007 applied via the Cloudflare dashboard D1 console
-- (Storage & Databases → D1 → sphere-feedback → Console), for deploys
-- where running `wrangler d1 migrations apply FEEDBACK_DB --remote`
-- from a terminal isn't convenient.
--
-- Statements mirror migrations/0007_general_feedback_standalone.sql
-- exactly, plus the wrangler bookkeeping row at the end so a future
-- `wrangler d1 migrations apply` doesn't try to re-run 0007. If the
-- console rejects a multi-statement paste, run each statement
-- individually, top to bottom.

CREATE TABLE general_feedback_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('bug', 'feature', 'other', 'idea', 'content')),
    message TEXT NOT NULL,
    contact TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    app_version TEXT NOT NULL DEFAULT '',
    platform TEXT NOT NULL DEFAULT '',
    dataset_id TEXT,
    screenshot TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    source TEXT NOT NULL DEFAULT '',
    rating INTEGER CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
    reporter_name TEXT NOT NULL DEFAULT '',
    meta TEXT NOT NULL DEFAULT '',
    screenshot_r2_key TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',
    country TEXT NOT NULL DEFAULT ''
);

INSERT INTO general_feedback_new (
    id, kind, message, contact, url, user_agent, app_version,
    platform, dataset_id, screenshot, created_at
)
SELECT id, kind, message, contact, url, user_agent, app_version,
       platform, dataset_id, screenshot, created_at
FROM general_feedback;

DROP TABLE general_feedback;

ALTER TABLE general_feedback_new RENAME TO general_feedback;

CREATE INDEX IF NOT EXISTS idx_general_feedback_kind ON general_feedback (kind);

CREATE INDEX IF NOT EXISTS idx_general_feedback_created_at ON general_feedback (created_at);

-- Wrangler migration bookkeeping (prevents a future CLI apply from
-- re-running 0007):
INSERT INTO d1_migrations (name) VALUES ('0007_general_feedback_standalone.sql');

-- ── Post-deploy verification queries (run after the curl tests) ────
--
-- Confirm the schema took:
--   SELECT sql FROM sqlite_master WHERE name = 'general_feedback';
--
-- Confirm submissions are landing (newest first):
--   SELECT id, kind, message, rating, reporter_name, contact, status,
--          source, country, screenshot_r2_key, meta, created_at
--   FROM general_feedback ORDER BY id DESC LIMIT 5;
--
-- A row with a non-empty screenshot_r2_key should have a matching
-- object in R2 → terraviz-assets → feedback/screenshots/.
