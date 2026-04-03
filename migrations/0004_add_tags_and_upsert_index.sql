-- Add tags column for quick-select feedback tags
ALTER TABLE feedback ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';

-- Unique index on message_id for upsert support (second submission updates existing row)
CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_message_id ON feedback (message_id);
