-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 The Zyra Project

-- No backfill invents coverage or represented time from legacy fields.
-- Evidence is bounded curator/source text, never a URL to fetch or trust.
ALTER TABLE datasets ADD COLUMN bbox_provenance TEXT NOT NULL DEFAULT 'unknown' CHECK (bbox_provenance IN ('unknown', 'measured', 'declared_global', 'imported', 'inferred'));
ALTER TABLE datasets ADD COLUMN bbox_evidence TEXT CHECK (bbox_evidence IS NULL OR length(bbox_evidence) <= 2048);
ALTER TABLE datasets ADD COLUMN temporal_semantics TEXT NOT NULL DEFAULT 'unknown' CHECK (temporal_semantics IN ('unknown', 'represented', 'publication', 'schedule'));
ALTER TABLE datasets ADD COLUMN temporal_evidence TEXT CHECK (temporal_evidence IS NULL OR length(temporal_evidence) <= 2048);
ALTER TABLE datasets ADD COLUMN resource_kind TEXT NOT NULL DEFAULT 'unknown' CHECK (resource_kind IN ('unknown', 'product', 'presentation'));