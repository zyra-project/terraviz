-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 The Zyra Project

-- Store the rated assistant message text directly for easy JSONL export
-- (avoids parsing the full conversation JSON in export queries)
ALTER TABLE feedback ADD COLUMN assistant_message TEXT NOT NULL DEFAULT '';
