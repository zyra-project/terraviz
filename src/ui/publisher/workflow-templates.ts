/**
 * Curated workflow templates + stage snippets for the guided
 * authoring form (Phase Z3 of `docs/ZYRA_INTEGRATION_PLAN.md`).
 *
 * Templates are hard-coded in the portal chunk (the plan doc's
 * §Open questions lean: versioned with the app, revisit when a
 * second node wants different ones). The drought template is the
 * exact pipeline validated end-to-end by the Z0 spike runs; every
 * template satisfies the server-side allowlist and writes its MP4
 * to `WORKFLOW_OUTPUT_PATH` by construction.
 *
 * Frame-gap handling follows the zyra-scheduler pipeline's command
 * shape: `zyra process scan-frames … --output /work/frames-meta.json`
 * builds the cadence metadata, then `zyra process pad-missing
 * --frames-meta … --output-dir … --fill-mode <blank|solid|basemap|nearest>
 * [--basemap <img>] [--json-report …]` fills the gaps, and a second
 * scan-frames refreshes the metadata so the newly-padded frames are
 * reflected in the data range. pad-missing sits between the scans and
 * compose-video so cadence gaps don't show as time-jumps in the
 * animation. The drought template fills gaps from the bundled
 * vegetation basemap (the SOS DroughtRisk product's MISSING_FRAME);
 * other datasets typically use `--fill-mode nearest`.
 *
 * The drought template is recall-enabled: it drops `compose-video`
 * and ends on the frame set at `/work/images/frames`, which the
 * runner publishes through the image-sequence asset path. The
 * transcode builds the same HLS video AND lights up the per-dataset
 * `/frames` download surface (`docs/ZYRA_INTEGRATION_PLAN.md`
 * §Real-time frame store). Templates that want a plain composed
 * video keep `compose-video` (see `http-frames-sos`).
 *
 * Padded→real freshening — what the scheduler's
 * `acquire --prefer-remote-if-meta-newer` flag does — is handled
 * runner-side, not by a template flag: the R2 frame cache keeps
 * pad-missing's synthetic frames out of the cache, so the next run's
 * `acquire --sync-dir` re-fetches the real frame once it lands. See
 * `cli/lib/r2-frames.ts` and `docs/ZYRA_INTEGRATION_PLAN.md`
 * §Real-time frame store.
 *
 * The stage snippets back the "Insert stage" palette — the
 * lightweight, textarea-native form of zyra-editor's stage palette
 * (see the plan doc's §Non-goals for why there is no node graph).
 *
 * Arg-name gotcha: `zyra run` emits a per-command list of
 * positionals as bare args and everything else as `--flags`
 * (`pipeline_runner._build_argv_for_stage`). The source URL is a
 * positional, and its key differs by backend — `acquire ftp` uses
 * `path:` (→ `zyra acquire ftp <url>`), while `acquire http` uses
 * `url:`. Using `url:` on an ftp stage produces a rejected `--url`
 * flag, so keep the ftp templates on `path:`.
 */

import type { MessageKey } from '../../i18n/messages'

export interface WorkflowTemplate {
  id: string
  /** i18n key for the picker label. */
  labelKey: MessageKey
  pipelineYaml: string
  metadataTemplate: string
}

// i18n-exempt: the template bodies below are machine pipeline
// config (YAML/JSON handed to Zyra and the publish API), not
// user-visible UI copy.
export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  {
    id: 'ftp-frames-sos',
    labelKey: 'publisher.workflows.template.ftpFrames',
    pipelineYaml: `stages:
  - stage: acquire
    command: ftp
    args:
      path: ftp://ftp.nnvl.noaa.gov/SOS/DroughtRisk_Weekly
      sync-dir: /work/images/frames
      since-period: P1Y
      pattern: '^DroughtRisk_Weekly_[0-9]{8}\\.png$'
      date-format: '%Y%m%d'
  - stage: process
    command: scan-frames
    args:
      frames-dir: /work/images/frames
      pattern: '^DroughtRisk_Weekly_[0-9]{8}\\.png$'
      datetime-format: '%Y%m%d'
      period-seconds: 604800
      output: /work/frames-meta.json
  - stage: process
    command: pad-missing
    args:
      frames-meta: /work/frames-meta.json
      output-dir: /work/images/frames
      fill-mode: basemap
      basemap: pkg:zyra.assets/images/earth_vegetation.jpg
      json-report: /work/pad-missing-report.json
  - stage: process
    command: scan-frames
    args:
      frames-dir: /work/images/frames
      pattern: '^DroughtRisk_Weekly_[0-9]{8}\\.png$'
      datetime-format: '%Y%m%d'
      period-seconds: 604800
      output: /work/frames-meta.json
`,
    metadataTemplate: `{
  "title": "My real-time dataset",
  "abstract": "Updated automatically. Current data range: {{data_start}} to {{data_end}}.",
  "keywords": ["real-time"],
  "start_time": "{{data_start}}",
  "end_time": "{{data_end}}",
  "period": "{{data_period}}",
  "organization": "NOAA",
  "attribution_text": "NOAA"
}`,
  },
  {
    id: 'http-frames-sos',
    labelKey: 'publisher.workflows.template.httpFrames',
    pipelineYaml: `stages:
  - stage: acquire
    command: http
    args:
      url: https://example.org/frames/
      sync-dir: /work/images/frames
      pattern: '^frame_[0-9]{8}\\.png$'
      date-format: '%Y%m%d'
  - stage: process
    command: scan-frames
    args:
      frames-dir: /work/images/frames
      pattern: '^frame_[0-9]{8}\\.png$'
      datetime-format: '%Y%m%d'
      period-seconds: 86400
      output: /work/frames-meta.json
  - stage: process
    command: pad-missing
    args:
      frames-meta: /work/frames-meta.json
      output-dir: /work/images/frames
      fill-mode: nearest
  - stage: visualize
    command: compose-video
    args:
      frames: /work/images/frames
      output: /work/output/dataset.mp4
`,
    metadataTemplate: `{
  "title": "My real-time dataset",
  "abstract": "Updated automatically. Current data range: {{data_start}} to {{data_end}}.",
  "keywords": ["real-time"],
  "start_time": "{{data_start}}",
  "end_time": "{{data_end}}",
  "period": "{{data_period}}"
}`,
  },
]

/**
 * One indentation-ready YAML snippet per allowlisted stage/command,
 * for the "Insert stage" palette. Args are the working defaults
 * from the spike-validated pipelines; placeholders are obvious
 * enough to edit in place.
 */
// i18n-exempt: machine pipeline config, not UI copy.
export const STAGE_SNIPPETS: ReadonlyArray<{ id: string; snippet: string }> = [
  {
    id: 'acquire ftp',
    snippet: `  - stage: acquire
    command: ftp
    args:
      path: ftp://host/path
      sync-dir: /work/images/frames
      since-period: P1Y
      pattern: '^frame_[0-9]{8}\\.png$'
      date-format: '%Y%m%d'
`,
  },
  {
    id: 'acquire http',
    snippet: `  - stage: acquire
    command: http
    args:
      url: https://example.org/data
      output: /work/source.bin
`,
  },
  {
    id: 'process convert-format',
    snippet: `  - stage: process
    command: convert-format
    args:
      input: /work/source.bin
      format: netcdf
`,
  },
  {
    id: 'process scan-frames',
    snippet: `  - stage: process
    command: scan-frames
    args:
      frames-dir: /work/images/frames
      pattern: '^frame_[0-9]{8}\\.png$'
      datetime-format: '%Y%m%d'
      period-seconds: 86400
      output: /work/frames-meta.json
`,
  },
  {
    id: 'process pad-missing',
    snippet: `  - stage: process
    command: pad-missing
    args:
      frames-meta: /work/frames-meta.json
      output-dir: /work/images/frames
      fill-mode: nearest
`,
  },
  {
    id: 'visualize compose-video',
    snippet: `  - stage: visualize
    command: compose-video
    args:
      frames: /work/images/frames
      output: /work/output/dataset.mp4
`,
  },
]
