-- 0018_workflows.sql — Phase Z1 of docs/ZYRA_INTEGRATION_PLAN.md —
-- D1-resident Zyra workflow definitions + per-execution run rows.
--
-- A `workflows` row is a registered, schedulable Zyra pipeline that
-- maintains exactly one dataset (`target_dataset_id`) by overwriting
-- it in place each run (update_mode 'overwrite' is the only mode in
-- v1; the column reserves the slot for the image-sequence plan's
-- Phase 2 append). Definitions live here — not in a separate repo —
-- so forked nodes stay self-contained; execution happens on the
-- node's own GitHub Actions via repository_dispatch.
--
-- `pipeline_json` is the Zyra pipeline as canonical JSON (the portal
-- authors YAML and converts client-side; Zyra accepts JSON manifests
-- natively, and storing JSON keeps a YAML parser out of the Pages
-- Functions bundle). `metadata_template` is the sidecar template the
-- runner interpolates into the dataset PATCH each run.
--
-- `schedule` is an ISO-8601 duration (PT1H, P1D, P1W…) — the same
-- vocabulary as `datasets.period`, not cron. `next_run_at` is
-- computed server-side on save and bumped when a scheduled run is
-- queued; the GHA scheduler tick reads `enabled = 1 AND next_run_at
-- <= now` (see the index below).
--
-- `workflow_runs` is one row per execution, append-only apart from
-- status transitions (queued → running → succeeded/failed/canceled).
-- `gha_run_id` links the portal's run history to the Actions log;
-- `upload_id` records which asset_uploads row a successful run
-- produced.

CREATE TABLE workflows (
  id                 TEXT PRIMARY KEY,            -- ULID
  publisher_id       TEXT NOT NULL,
  name               TEXT NOT NULL,
  description        TEXT,
  pipeline_json      TEXT NOT NULL,               -- canonical JSON, validated against the stage allowlist
  metadata_template  TEXT NOT NULL,               -- sidecar template JSON
  schedule           TEXT NOT NULL,               -- ISO-8601 duration (same vocabulary as datasets.period)
  enabled            INTEGER NOT NULL DEFAULT 0,  -- 0 | 1
  target_dataset_id  TEXT NOT NULL,
  update_mode        TEXT NOT NULL DEFAULT 'overwrite',
  last_run_at        TEXT,                        -- ISO 8601; terminal status of the most recent run
  next_run_at        TEXT,                        -- ISO 8601; null while disabled
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  FOREIGN KEY (publisher_id)      REFERENCES publishers(id),
  FOREIGN KEY (target_dataset_id) REFERENCES datasets(id)
);

-- The scheduler tick's exact predicate.
CREATE INDEX idx_workflows_due ON workflows (enabled, next_run_at);

CREATE TABLE workflow_runs (
  id            TEXT PRIMARY KEY,                 -- ULID
  workflow_id   TEXT NOT NULL,
  status        TEXT NOT NULL,                    -- queued | running | succeeded | failed | canceled
  trigger       TEXT NOT NULL DEFAULT 'schedule', -- schedule | manual
  created_at    TEXT NOT NULL,
  started_at    TEXT,                             -- set on the `running` callback
  finished_at   TEXT,                             -- set on a terminal callback
  gha_run_id    TEXT,                             -- Actions run id, for the portal's log link
  upload_id     TEXT,                             -- asset_uploads row a successful run produced
  error_summary TEXT,                             -- truncated, secret-stripped (runner-side sanitization)
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

-- Run history is read newest-first per workflow; the active-run
-- guard filters on status.
CREATE INDEX idx_workflow_runs_workflow ON workflow_runs (workflow_id, created_at DESC);
CREATE INDEX idx_workflow_runs_active ON workflow_runs (workflow_id, status);
