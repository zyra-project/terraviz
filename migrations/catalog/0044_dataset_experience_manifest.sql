-- TerraViz-authoritative presentation metadata plus private importer state.
--
-- experience_manifest is a versioned JSON document for synchronized dataset
-- features (audio, caption tracks, endpoint dwell, simultaneous layers, and
-- globe/data-synchronized overlays). Sequential narration and camera actions
-- remain Tours. source_import_state is a privileged-only JSON snapshot used by
-- importers for three-way merge; it is intentionally not serialized publicly.

ALTER TABLE datasets ADD COLUMN experience_manifest TEXT;
ALTER TABLE datasets ADD COLUMN source_import_state TEXT;

