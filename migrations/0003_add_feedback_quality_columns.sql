-- Add columns for richer RLHF data capture
ALTER TABLE feedback ADD COLUMN user_message TEXT NOT NULL DEFAULT '';
ALTER TABLE feedback ADD COLUMN turn_index INTEGER;
ALTER TABLE feedback ADD COLUMN history_compressed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE feedback ADD COLUMN action_clicks TEXT NOT NULL DEFAULT '[]';
