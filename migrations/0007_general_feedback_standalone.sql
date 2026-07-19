-- Extend general_feedback for the standalone TerraViz build's in-app
-- feedback widget (POST /api/feedback with source
-- "terraviz-standalone"). Submissions land in the same queue the
-- Publisher Portal's Feedback → General tab already reviews, rather
-- than a parallel table.
--
-- SQLite cannot ALTER a CHECK constraint, so widening `kind` to admit
-- the widget's 'idea' and 'content' types requires the standard
-- rebuild-copy-rename dance. New columns, all defaulted so existing
-- rows and the existing /api/general-feedback insert keep working:
--
--   source            client identifier ('' for the in-SPA Help form,
--                     'terraviz-standalone' for the widget)
--   rating            optional 1–5 star rating (NULL when not given)
--   reporter_name     optional reporter display name
--   meta              app-state snapshot as a JSON object ('' = none)
--   screenshot_r2_key R2 object key for a binary screenshot; the
--                     legacy `screenshot` data-URL column stays for
--                     old rows and the small in-SPA captures
--   status            triage state; every submission starts 'new'
--   country           coarse reporter location from CF-IPCountry
--
-- destructive: reviewed
-- Rollout reasoning: the DROP/RENAME is the SQLite CHECK-widening
-- rebuild, applied as one migration batch — every row is copied into
-- the replacement table (same column names/order, ids preserved via
-- explicit id copy) before the old table is dropped. Code running
-- against either schema version keeps working: pre-0007 code inserts
-- and selects only columns that survive unchanged, and every added
-- column is defaulted. Feedback volume is tiny, so the swap window
-- carries no meaningful write risk.

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
