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
 * The stage snippets back the "Insert stage" palette — the
 * lightweight, textarea-native form of zyra-editor's stage palette
 * (see the plan doc's §Non-goals for why there is no node graph).
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
      url: ftp://ftp.nnvl.noaa.gov/SOS/DroughtRisk_Weekly
      sync-dir: /work/images/frames
      since-period: P1Y
      pattern: '^DroughtRisk_Weekly_[0-9]{8}\\.png$'
      date-format: '%Y%m%d'
  - stage: transform
    command: metadata
    args:
      frames-dir: /work/images/frames
      pattern: '^DroughtRisk_Weekly_[0-9]{8}\\.png$'
      datetime-format: '%Y%m%d'
      period-seconds: 604800
      output: /work/frames-meta.json
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
  - stage: transform
    command: metadata
    args:
      frames-dir: /work/images/frames
      pattern: '^frame_[0-9]{8}\\.png$'
      datetime-format: '%Y%m%d'
      period-seconds: 86400
      output: /work/frames-meta.json
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
      url: ftp://host/path
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
    id: 'transform metadata',
    snippet: `  - stage: transform
    command: metadata
    args:
      frames-dir: /work/images/frames
      pattern: '^frame_[0-9]{8}\\.png$'
      datetime-format: '%Y%m%d'
      period-seconds: 86400
      output: /work/frames-meta.json
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
