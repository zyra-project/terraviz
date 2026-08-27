-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 The Zyra Project

-- 0027_event_inference.sql — AI-inferred field provenance on current
-- events (docs/CURRENT_EVENTS_PLAN.md §9, feeds slice C).
--
-- Plain news items (the bring-your-own-RSS kind) often arrive without
-- the occurred time or a location — exactly the metadata the matcher's
-- temporal/geo signals need. Slice C fills those gaps at ingest with a
-- Workers AI extraction over the headline + summary (place names
-- constrained to the regions.ts vocabulary, dates anchored to the
-- item's publish date), confidence-gated, and only ever for fields the
-- feed did NOT provide.
--
-- `inferred_fields` records which fields were AI-filled — a JSON array
-- like '["occurredStart","geometry"]', NULL when everything came from
-- the source. It exists so the curator review queue can badge inferred
-- metadata ("AI-inferred") and a curator knows to double-check it
-- before approving; it is provenance, not behaviour.
--
-- Additive only: one nullable column on an existing table.

ALTER TABLE current_events ADD COLUMN inferred_fields TEXT;
