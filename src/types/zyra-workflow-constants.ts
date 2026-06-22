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
 */
export const ZYRA_STAGE_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  acquire: ['http', 'ftp', 's3'],
  process: ['decode-grib2', 'extract-variable', 'convert-format', 'metadata', 'scan-frames', 'pad-missing'],
  transform: ['metadata', 'scan-frames'],
  visualize: ['heatmap', 'contour', 'animate', 'compose-video'],
  export: ['local'],
}

/** Bounds on a stored pipeline. */
export const MAX_PIPELINE_STAGES = 12
export const MAX_PIPELINE_JSON_BYTES = 32 * 1024
export const MAX_PIPELINE_ARG_LENGTH = 2000

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

/** Placeholder names the runner can interpolate into template
 *  string values as `{{name}}`. The `data_*` trio derives from the
 *  pipeline's `frames-meta.json` when present (`start_datetime` /
 *  `end_datetime` / `period_seconds` per upstream's
 *  `_compute_frames_metadata()`). */
export const METADATA_TEMPLATE_VARIABLES: readonly string[] = [
  'run_date',
  'run_id',
  'data_start',
  'data_end',
  'data_period',
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
