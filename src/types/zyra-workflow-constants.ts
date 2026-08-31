// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Constants shared by the publisher API (`functions/`), the GHA
 * runner CLI (`cli/`), and the portal (`src/`) for the Zyra
 * workflow pipeline (Phase Z1 of `docs/ZYRA_INTEGRATION_PLAN.md`).
 * Mirrors the role `image-sequence-constants.ts` plays for the
 * upload pipeline: one definition both sides of the wire agree on.
 */

/**
 * The stage/command allowlist `/validate` (and dispatch-time
 * re-validation) checks every pipeline entry against. Zyra stages
 * are declarative, not shell, which is what keeps an allowlist
 * meaningful — but it is only meaningful against a known Zyra
 * version, so this table is coupled to the runner container digest
 * in `.github/workflows/zyra-run.yml` and the two are bumped
 * together, deliberately.
 *
 * Verified against the Z0 spike run (actions/runs/27286624666),
 * which also surfaced that upstream merged the `transform` stage
 * into `process` — `transform metadata` still works as a
 * deprecated alias (also named `scan-frames`), so both spellings
 * are allowlisted until curated templates settle on `process`.
 *
 * `reproject` (NOAA-GSL/zyra#295/#306) was added together with the
 * runner bump to zyra v0.1.49, the first release carrying it.
 */
export const ZYRA_STAGE_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  acquire: ['http', 'ftp', 's3'],
  process: ['decode-grib2', 'extract-variable', 'convert-format', 'reproject', 'metadata', 'scan-frames', 'pad-missing'],
  transform: ['metadata', 'scan-frames'],
  visualize: ['heatmap', 'contour', 'animate', 'compose-video'],
  export: ['local'],
}

/** Bounds on a stored pipeline. */
export const MAX_PIPELINE_STAGES = 12
/** Size of the whole stored pipeline.
 *
 * Raised from 32 KiB alongside the list bound below. A per-frame
 * pipeline repeats a long templated URL once per list, so the byte
 * count grows with frame count and hits this before anything else
 * does: an 85-frame RRFS forecast serialises to ~27 KiB, i.e. 83% of
 * the old bound. Raising only the item count would have shipped a
 * pipeline one edit — a longer palette URL — away from failing. */
export const MAX_PIPELINE_JSON_BYTES = 64 * 1024
export const MAX_PIPELINE_ARG_LENGTH = 2000
/** Items in a single array-valued pipeline arg (`inputs`,
 *  `output_names`, …).
 *
 * Was 16, which is exactly the frame count of the first workflow
 * written against it — the bound and its only consumer were the same
 * size, so nothing had pushed on it. It is a real limit though: a
 * forecast that wants an hourly frame per lead hour needs one list
 * entry per frame, and RRFS publishes to f084.
 *
 * 128 is chosen to clear that (85) with room, while still refusing a
 * runaway generated pipeline. These lists become CLI argv for the zyra
 * container, so the bound is about keeping a stored pipeline sane
 * rather than about any single downstream limit. */
export const MAX_PIPELINE_ARG_LIST_ITEMS = 128

/** Bounds on the metadata sidecar template. */
export const MAX_METADATA_TEMPLATE_BYTES = 8 * 1024

/**
 * Dataset-PATCH fields a metadata template may set. Subset of the
 * publisher API's dataset surface — the sidecar invents no new
 * metadata vocabulary (`docs/ZYRA_INTEGRATION_PLAN.md` §Metadata
 * sidecar).
 */
export const METADATA_TEMPLATE_ALLOWED_FIELDS: readonly string[] = [
  'title',
  'abstract',
  'categories',
  'keywords',
  'start_time',
  'end_time',
  'period',
  'license_spdx',
  'license_url',
  'license_statement',
  'attribution_text',
  'organization',
  'website_link',
]

/**
 * Placeholder names the runner can interpolate into template string
 * values. Two families, resolved differently:
 *
 *   - `{{name}}` — `run_date`, `run_id`, and the `data_*` trio. The
 *     latter derives from the pipeline's `frames-meta.json` when
 *     present (`start_datetime` / `end_datetime` / `period_seconds`
 *     per upstream's `_compute_frames_metadata()`), and so reports
 *     what the frames on disk actually are.
 *   - `{{valid_iso:INTERVAL:LAG[:OFFSET]}}` — the valid time of a
 *     forecast hour of the current cycle, from the same clock
 *     arithmetic the pipeline args use. It always resolves and needs
 *     no `scan-frames` stage, so it is how a dataset gets dates when
 *     its frames carry cycle-relative names. It is a prediction
 *     rather than an observation, though: `data_*` stays the
 *     truthful choice when the frames are named by valid time and
 *     `frames-meta.json` exists.
 *
 * Syntax and parsing live in `zyra-pipeline-args.ts`; this list only
 * decides which names are in scope for a metadata template.
 */
export const METADATA_TEMPLATE_VARIABLES: readonly string[] = [
  'run_date',
  'run_id',
  'data_start',
  'data_end',
  'data_period',
  'valid_iso',
  'valid_compact',
]

/**
 * Where a pipeline must write its MP4, from the runner container's
 * point of view (the workflow mounts the workdir at `/work`).
 * `/validate` requires at least one stage arg to equal this path so
 * a registered pipeline can't silently produce nothing the publish
 * leg can find; curated portal templates comply by construction.
 */
export const WORKFLOW_OUTPUT_PATH = '/work/output/dataset.mp4'

/**
 * Where a frames-output (recall-enabled) pipeline leaves its frame
 * sequence, from the runner container's point of view. Such a
 * pipeline drops `compose-video` and publishes its padded frames
 * through the image-sequence asset path instead — the transcode
 * builds the same HLS bundle and the `/frames` surface lights up
 * (`docs/ZYRA_INTEGRATION_PLAN.md` §Real-time frame store).
 *
 * `/validate` accepts a pipeline that writes the MP4 to
 * `WORKFLOW_OUTPUT_PATH` **or** declares this frames directory as a
 * stage arg (`sync-dir` / `frames-dir` / `output-dir`), so a
 * registered pipeline still can't silently produce nothing the
 * publish leg can find. The runner reads frames from here when no
 * MP4 was produced.
 */
export const WORKFLOW_FRAMES_OUTPUT_DIR = '/work/images/frames'

/** Run lifecycle vocabulary (workflow_runs.status). */
export const WORKFLOW_RUN_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
] as const
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number]

/** Statuses that block a new run of the same workflow. */
export const WORKFLOW_RUN_ACTIVE_STATUSES: readonly WorkflowRunStatus[] = [
  'queued',
  'running',
]

/** Schedule bounds: the GHA scheduler ticks every 15 minutes, so
 *  anything tighter can never be honored; the ceiling keeps
 *  `next_run_at` arithmetic sane. */
export const MIN_SCHEDULE_SECONDS = 15 * 60
export const MAX_SCHEDULE_SECONDS = 90 * 24 * 60 * 60

/** Cap on `error_summary` persisted from runner callbacks. */
export const MAX_ERROR_SUMMARY_LENGTH = 500
