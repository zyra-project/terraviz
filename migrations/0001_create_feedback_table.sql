-- Create feedback table for storing AI response ratings
CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rating TEXT NOT NULL CHECK (rating IN ('thumbs-up', 'thumbs-down')),
    comment TEXT NOT NULL DEFAULT '',
    message_id TEXT NOT NULL,
    dataset_id TEXT,
    conversation TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for querying by rating and date range
CREATE INDEX IF NOT EXISTS idx_feedback_rating ON feedback (rating);
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback (created_at);
