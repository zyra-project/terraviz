-- Create general_feedback table for app-level user reports
-- (bug reports, feature requests, other feedback) — kept separate from
-- the AI response feedback table since the shape and constraints differ.
CREATE TABLE IF NOT EXISTS general_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('bug', 'feature', 'other')),
    message TEXT NOT NULL,
    contact TEXT NOT NULL DEFAULT '',      -- optional email/handle
    url TEXT NOT NULL DEFAULT '',          -- window.location at submit time
    user_agent TEXT NOT NULL DEFAULT '',
    app_version TEXT NOT NULL DEFAULT '',
    platform TEXT NOT NULL DEFAULT '',     -- 'web' | 'desktop'
    dataset_id TEXT,                       -- active dataset, if any
    screenshot TEXT NOT NULL DEFAULT '',   -- optional base64 JPEG data URL
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for triage queries by kind and by date range
CREATE INDEX IF NOT EXISTS idx_general_feedback_kind ON general_feedback (kind);
CREATE INDEX IF NOT EXISTS idx_general_feedback_created_at ON general_feedback (created_at);
