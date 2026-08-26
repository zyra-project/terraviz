#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `zyra-publish-from-dispatch` — the runner CLI for Phase Z1 of
 * `docs/ZYRA_INTEGRATION_PLAN.md`, invoked by the `zyra-run`
 * GitHub Actions workflow when a workflow execution is dispatched.
 * The graduated form of the Z0 spike's publish leg
 * (`zyra-spike-publish.ts`), split into three phases so the Zyra
 * container step can sit between them:
 *
 *   --phase=fetch    Fetch the workflow definition from the API,
 *                    write `{workdir}/pipeline.json` (what
 *                    `zyra run` executes) + `{workdir}/workflow.json`
 *                    (the full row, read back by the publish
 *                    phase), and POST the `running` status callback
 *                    with the GHA run id.
 *   --phase=publish  After Zyra wrote the MP4: render the metadata
 *                    sidecar (template + run vars + optional
 *                    frames-meta.json), preflight the MP4 against
 *                    the SOS spec, PATCH the target dataset, run
 *                    the asset init → presigned PUT → complete
 *                    sequence (the existing transcode pipeline
 *                    takes over), poll until `data_ref` flips, and
 *                    POST `succeeded` with the upload id.
 *   --phase=report-failure
 *                    POST `failed` with a sanitized, truncated
 *                    error summary. The workflow calls this from an
 *                    `if: failure()` step so any broken step still
 *                    lands a terminal status in `workflow_runs`.
 *   --phase=acquire-softpass
 *                    After `zyra run` failed: decide whether it was a
 *                    transient NOAA-FTP `acquire` hiccup over a still-
 *                    fresh published bundle. If so, POST a no-op
 *                    `succeeded` (the run lands GREEN, no false-
 *                    positive notification); otherwise exit non-zero
 *                    and let the `if: failure()` step report `failed`.
 *                    See `cli/lib/zyra-acquire-softpass.ts`.
 *
 * Environment (same resolution as every `terraviz` command — see
 * `cli/lib/config.ts`): TERRAVIZ_SERVER,
 * TERRAVIZ_ACCESS_CLIENT_ID, TERRAVIZ_ACCESS_CLIENT_SECRET, or
 * TERRAVIZ_INSECURE_LOCAL against a DEV_BYPASS_ACCESS dev server.
 *
 * Exit codes (operator-skimmable, `transcode-from-dispatch.ts`
 * convention):
 *
 *   0 — phase succeeded
 *   1 — argument / env validation error
 *   2 — publisher API call failed (fetch / status / PATCH)
 *   3 — SOS spec preflight failed (hard failures)
 *   4 — asset init / PUT / complete failed
 *
 * (A transcode that outlasts the --wait-seconds window is NOT a
 * failure: the asset published and the encode finalizes
 * asynchronously, so the publish phase reports success. The former
 * exit code 5 is retired.)
 */

import { createHash } from 'node:crypto'
import { readFile, writeFile, stat, mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { resolveConfig } from './lib/config'
import { TerravizClient } from './lib/client'
import { assessSosSpec, runFfprobe } from './lib/sos-spec'
import {
  buildRunVars,
  renderSidecar,
  sanitizeErrorSummary,
} from './lib/workflow-sidecar'
import {
  deleteR2Object,
  getR2ObjectText,
  listR2KeysPaginated,
  loadR2ConfigFromEnv,
  r2ObjectExists,
  type R2UploadConfig,
} from './lib/r2-upload'
import { frameHexFromKey, frameStorePrefix, selectFrameOrphans } from './lib/frame-store'
import { renderPipelineJson } from '../src/types/zyra-pipeline-args'
import {
  COLOR_SCALE_MAX_CHARS,
  parseColorScale,
  RENDER_ENCODING_DATA_LUMA,
} from '../src/types/color-scale'
import {
  isoDurationToSeconds,
  purgeFramesFromR2,
  restoreFramesFromR2,
  saveFramesToR2,
  windowFrameBudget,
} from './lib/r2-frames'
import { publishFrameSequence } from './lib/frames-publish'
import {
  assessBundleFreshness,
  classifyZyraFailure,
  decideAcquireSoftPass,
} from './lib/zyra-acquire-softpass'
import {
  WORKFLOW_FRAMES_OUTPUT_DIR,
  WORKFLOW_OUTPUT_PATH,
} from '../src/types/zyra-workflow-constants'

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

/** Default staleness threshold for the acquire soft-pass (2 days):
 *  how long the published bundle's trailing edge may fall behind real
 *  time before a transient acquire failure escalates instead of
 *  soft-passing. Overridable per node via the workflow's
 *  ZYRA_STALE_AFTER_SECONDS repo variable. */
const DEFAULT_STALE_AFTER_SECONDS = 172_800
/** Upper bound on --stale-after-seconds (30 days) — a guard against a
 *  fat-fingered repo variable that would let an indefinite outage
 *  soft-pass forever. */
const MAX_STALE_AFTER_SECONDS = 2_592_000

export type Phase =
  | 'fetch'
  | 'publish'
  | 'report-failure'
  | 'acquire-softpass'
  | 'restore-frames'
  | 'save-frames'

export interface Args {
  phase: Phase
  workflowId: string
  runId: string
  workdir: string
  ghaRunId: string | null
  video: string
  waitSeconds: number
  errorSummary: string
  /** Terminal status for report-failure: `failed` (default) or
   *  `canceled` when the GHA job was cancelled or timed out. */
  terminalStatus: 'failed' | 'canceled'
  ffprobeBin: string
  /** Path to the captured `zyra run` combined output — the
   *  acquire-softpass classifier's input. */
  zyraLog: string | null
  /** Staleness threshold (seconds) for the acquire soft-pass. */
  staleAfterSeconds: number
}

export function parseArgs(argv: readonly string[]): Args | { error: string } {
  const get = (name: string): string | null => {
    const prefix = `--${name}=`
    const match = argv.find(a => a.startsWith(prefix))
    return match ? match.slice(prefix.length) : null
  }

  const phase = get('phase')
  if (
    phase !== 'fetch' &&
    phase !== 'publish' &&
    phase !== 'report-failure' &&
    phase !== 'acquire-softpass' &&
    phase !== 'restore-frames' &&
    phase !== 'save-frames'
  ) {
    return {
      error: `--phase must be fetch, publish, report-failure, acquire-softpass, restore-frames, or save-frames; got ${phase ?? '(missing)'}`,
    }
  }
  const workflowId = get('workflow-id')
  if (!workflowId || !ULID_RE.test(workflowId)) {
    return { error: `--workflow-id must be a ULID; got ${workflowId ?? '(missing)'}` }
  }
  const runId = get('run-id')
  if (!runId || !ULID_RE.test(runId)) {
    return { error: `--run-id must be a ULID; got ${runId ?? '(missing)'}` }
  }
  const workdir = get('workdir') ?? '_work'
  const waitRaw = get('wait-seconds')
  const waitSeconds = waitRaw === null ? 1800 : Number(waitRaw)
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 21_600) {
    return { error: `--wait-seconds must be an integer 0..21600; got ${waitRaw}` }
  }
  const staleRaw = get('stale-after-seconds')
  const staleAfterSeconds = staleRaw === null ? DEFAULT_STALE_AFTER_SECONDS : Number(staleRaw)
  if (
    !Number.isInteger(staleAfterSeconds) ||
    staleAfterSeconds < 0 ||
    staleAfterSeconds > MAX_STALE_AFTER_SECONDS
  ) {
    return {
      error: `--stale-after-seconds must be an integer 0..${MAX_STALE_AFTER_SECONDS}; got ${staleRaw}`,
    }
  }
  // Derived before the literal so the default summary can agree with
  // it. The workflow always passes --error-summary, but the CLI is
  // hand-runnable, and "Workflow run failed" stored against a
  // `canceled` row contradicts the row it is attached to.
  const terminalStatus: Args['terminalStatus'] =
    get('status') === 'canceled' ? 'canceled' : 'failed'

  return {
    phase,
    workflowId,
    runId,
    workdir,
    ghaRunId: get('gha-run-id'),
    video: get('video') ?? join(workdir, 'output', 'dataset.mp4'),
    waitSeconds,
    errorSummary:
      get('error-summary') ??
      (terminalStatus === 'canceled'
        ? 'Workflow run cancelled (no detail provided).'
        : 'Workflow run failed (no detail provided).'),
    terminalStatus,
    ffprobeBin: get('ffprobe-bin') ?? 'ffprobe',
    zyraLog: get('zyra-log'),
    staleAfterSeconds,
  }
}

/** Wire shape subset of `GET /workflows/{id}`. */
interface WorkflowEnvelope {
  workflow: {
    id: string
    pipeline_json: string
    metadata_template: string
    schedule: string
    target_dataset_id: string
  }
}

interface DatasetEnvelope {
  dataset: {
    id: string
    data_ref?: string | null
    transcoding?: number | null
    end_time?: string | null
    updated_at?: string | null
    frame_source_filenames_ref?: string | null
  }
}

interface AssetInitResponse {
  upload_id: string
  target: 'r2' | 'stream'
  r2?: { method: string; url: string; headers: Record<string, string>; key: string }
  mock?: boolean
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const log = (line: string) => console.error(`[zyra-run] ${line}`)

/** POST /complete with retries — the handler's repository_dispatch
 *  call to api.github.com can transiently 5xx (observed live in
 *  spike run 27288385890); complete is safe to retry because a
 *  duplicate dispatch is absorbed by the transcode guard. */
async function completeWithRetry(
  client: TerravizClient,
  datasetId: string,
  uploadId: string,
  attempts = 3,
): Promise<{ ok: boolean; status: number; error?: string }> {
  for (let i = 1; ; i++) {
    const result = await client.completeAssetUpload(datasetId, uploadId)
    if (result.ok) return { ok: true, status: result.status }
    const retryable = result.status === 0 || result.status >= 500
    if (!retryable || i >= attempts) {
      return { ok: false, status: result.status, error: result.error }
    }
    log(`WARN: complete attempt ${i} → ${result.status} ${result.error}; retrying`)
    await sleep(i * 10_000)
  }
}

/**
 * Find the pipeline's `frames-meta.json`, if it produced one.
 * Looks at `{workdir}/frames-meta.json` first (curated-template
 * convention), then the zyra-scheduler layout
 * `{workdir}/images/<dataset>/metadata/frames-meta.json`.
 */
export async function findFramesMeta(workdir: string): Promise<string | null> {
  const direct = join(workdir, 'frames-meta.json')
  if (existsSync(direct)) return direct
  const imagesDir = join(workdir, 'images')
  if (!existsSync(imagesDir)) return null
  try {
    for (const entry of await readdir(imagesDir)) {
      const candidate = join(imagesDir, entry, 'metadata', 'frames-meta.json')
      if (existsSync(candidate)) return candidate
    }
  } catch {
    /* unreadable images dir — treat as absent */
  }
  return null
}

/**
 * Materialize inline palettes before `zyra run` sees the pipeline.
 *
 * A `visualize heatmap` stage may carry its colour palette inline as a
 * `cmap_inline` string — the same JSON `--cmap-file` would otherwise
 * load from a URL — so a publisher can colour a data-encoded dataset
 * without hosting a palette file. For each such stage we write the JSON
 * to `{workdir}/cmap-<stageIndex>.json` — the zero-based index of the
 * stage in `stages[]`, so a workdir listing maps straight back to the
 * pipeline (the container sees the workdir at `/work`) — point
 * `cmap_file` at it, and drop `cmap_inline`, an unknown arg zyra would
 * otherwise reject. Both kebab and snake spellings are accepted,
 * mirroring `pipelineArg`.
 *
 * Throws, rather than warning or skipping, on three authoring mistakes,
 * because each one otherwise surfaces far from its cause:
 *
 *   - `cmap_inline` on a stage that is not `heatmap`. Only the
 *     data-encoded heatmap path consumes a palette file, so rewriting it
 *     into `cmap_file` elsewhere would hand zyra an arg that command does
 *     not accept and fail the run with an unrelated "unrecognized
 *     arguments" message. Silently ignoring it is worse still: the
 *     heatmap then has no palette and publishes a grayscale globe, which
 *     is the hardest data-encoded symptom to trace back.
 *   - a `cmap_inline` that is not valid JSON, which would otherwise fail
 *     deep inside zyra's `load_palette_spec` after a container spin-up.
 *   - a `cmap_inline` that is neither a JSON string nor an object.
 *
 * Returns the pipeline unchanged when no stage uses it.
 */
export async function materializeInlinePalettes(
  pipelineJson: string,
  workdir: string,
): Promise<string> {
  let doc: { stages?: unknown }
  try {
    doc = JSON.parse(pipelineJson) as { stages?: unknown }
  } catch {
    return pipelineJson
  }
  if (!Array.isArray(doc.stages)) return pipelineJson
  let count = 0
  for (let i = 0; i < doc.stages.length; i++) {
    const stage = doc.stages[i]
    if (typeof stage !== 'object' || stage === null) continue
    const stageArgs = (stage as { args?: unknown }).args
    if (typeof stageArgs !== 'object' || stageArgs === null || Array.isArray(stageArgs)) continue
    const a = stageArgs as Record<string, unknown>
    const inline = a['cmap_inline'] ?? a['cmap-inline']
    if (inline === undefined) continue
    const command = (stage as { command?: unknown }).command
    if (command !== 'heatmap') {
      throw new Error(
        `stages[${i}].args.cmap_inline is only supported on a "heatmap" stage ` +
          `(this stage is "${String(command)}") — only the data-encoded heatmap ` +
          `path reads a palette file`,
      )
    }
    let text: string
    if (typeof inline === 'string') {
      try {
        JSON.parse(inline)
      } catch {
        throw new Error(`stages[${i}].args.cmap_inline is not valid JSON`)
      }
      text = inline
    } else if (typeof inline === 'object' && inline !== null) {
      text = JSON.stringify(inline)
    } else {
      throw new Error(`stages[${i}].args.cmap_inline must be a JSON string or object`)
    }
    const name = `cmap-${i}.json`
    await writeFile(join(workdir, name), text)
    a['cmap_file'] = `/work/${name}`
    delete a['cmap_inline']
    delete a['cmap-inline']
    count++
  }
  if (count > 0) {
    log(`materialized ${count} inline palette${count === 1 ? '' : 's'} → /work/cmap-*.json`)
  }
  return JSON.stringify(doc)
}

async function phaseFetch(client: TerravizClient, args: Args): Promise<number> {
  const result = await client.getWorkflow<WorkflowEnvelope>(args.workflowId)
  if (!result.ok) {
    log(`FAIL: fetch workflow → ${result.status} ${result.error}`)
    return 2
  }
  const workflow = result.body.workflow
  await mkdir(args.workdir, { recursive: true })
  await mkdir(join(args.workdir, 'output'), { recursive: true })
  // Interpolate {{run_date}}/{{run_id}}/{{cycle_*}} placeholders in
  // pipeline args before the container sees them. A malformed or
  // unknown placeholder is a hard failure: rendering a literal
  // {{...}} into a source URL would fetch garbage.
  let renderedPipeline: string
  try {
    renderedPipeline = renderPipelineJson(workflow.pipeline_json, {
      now: new Date(),
      runId: args.runId,
    })
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    log(`FAIL: pipeline placeholder rendering → ${detail}`)
    await client.postWorkflowRunStatus(args.workflowId, args.runId, {
      status: 'failed',
      gha_run_id: args.ghaRunId,
      error_summary: sanitizeErrorSummary(`pipeline placeholder rendering: ${detail}`),
    })
    return 2
  }
  // Write any `cmap_inline` palette to a `/work` file and repoint
  // `cmap_file` at it, so a data-encoded dataset's colours travel in the
  // stored pipeline instead of a separately-hosted palette URL.
  try {
    renderedPipeline = await materializeInlinePalettes(renderedPipeline, args.workdir)
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    log(`FAIL: inline palette materialization → ${detail}`)
    await client.postWorkflowRunStatus(args.workflowId, args.runId, {
      status: 'failed',
      gha_run_id: args.ghaRunId,
      error_summary: sanitizeErrorSummary(`inline palette: ${detail}`),
    })
    return 2
  }
  await writeFile(join(args.workdir, 'pipeline.json'), renderedPipeline)
  await writeFile(join(args.workdir, 'workflow.json'), JSON.stringify(workflow))
  log(`fetched workflow ${workflow.id} → ${args.workdir}/pipeline.json`)

  const status = await client.postWorkflowRunStatus(args.workflowId, args.runId, {
    status: 'running',
    gha_run_id: args.ghaRunId,
  })
  if (!status.ok) {
    log(`FAIL: running callback → ${status.status} ${status.error}`)
    return 2
  }
  return 0
}

/**
 * Render the metadata sidecar from the workflow template +
 * frames-meta and PATCH the dataset. Shared by the video and
 * frame-sequence publish paths (the frame path needs it for the
 * `start_time` / `period` the `/frames` surface reads). Returns an
 * exit code on failure, or null on success.
 */
async function applyMetadataSidecar(
  client: TerravizClient,
  args: Args,
  workflow: WorkflowEnvelope['workflow'],
): Promise<number | null> {
  let framesMeta: unknown
  const metaPath = await findFramesMeta(args.workdir)
  if (metaPath) {
    try {
      framesMeta = JSON.parse(await readFile(metaPath, 'utf-8'))
      log(`frames-meta: ${metaPath}`)
    } catch {
      log(`WARN: ${metaPath} is unparsable — data_* template fields will drop`)
    }
  }
  const template = JSON.parse(workflow.metadata_template) as Record<string, unknown>
  const sidecar = renderSidecar(template, buildRunVars({ runId: args.runId, framesMeta }))
  for (const w of sidecar.warnings) log(`WARN: ${w}`)
  // The data-encoded pair rides along on the same PATCH, and it has to
  // land HERE rather than after the upload: `publishFrames` fires the
  // transcode via `/complete`, and the transcode job reads
  // `render_encoding` off the row to decide how to encode. Patching it
  // afterwards would race — the encode would already have run with the
  // picture argv.
  const fields: Record<string, unknown> = {
    ...sidecar.fields,
    ...(await readColorScaleFields(deriveColorScalePath(workflow.pipeline_json, args.workdir))),
  }
  if (Object.keys(fields).length > 0) {
    const patched = await client.updateDataset(workflow.target_dataset_id, fields)
    if (!patched.ok) {
      log(`FAIL: dataset PATCH → ${patched.status} ${patched.error}`)
      return 2
    }
    log(`dataset ${workflow.target_dataset_id} metadata updated (${Object.keys(fields).join(', ')})`)
  }
  return null
}

/**
 * Poll until the transcode flips `data_ref` to the expected bundle,
 * then POST the succeeded status. The expected ref is identical for
 * the MP4 and frame-sequence paths — both transcode to
 * `videos/{dataset}/{upload}/master.m3u8`.
 */
async function waitAndReportSucceeded(
  client: TerravizClient,
  args: Args,
  datasetId: string,
  uploadId: string,
): Promise<number> {
  if (args.waitSeconds > 0) {
    const started = Date.now()
    const deadline = started + args.waitSeconds * 1000
    const expectedRef = `r2:videos/${datasetId}/${uploadId}/master.m3u8`
    // Heartbeat so the step doesn't look dead while the (silent)
    // transcode runs — throttled to ~once a minute.
    let lastHeartbeat = 0
    for (;;) {
      if (Date.now() > deadline) {
        // The wait is a best-effort confirmation window, not a gate:
        // the asset upload + metadata PATCH already succeeded and the
        // transcode was dispatched, so a slow encode (a large
        // frame-sequence transcode can run 30+ min) must not
        // false-fail the run. Report success; the transcode finalizes
        // `data_ref` asynchronously and reports its own status. Tune
        // the window via --wait-seconds (0 = fire-and-forget).
        log(
          `transcode still running after ${args.waitSeconds}s — asset published and transcode dispatched; reporting success (it finalizes asynchronously)`,
        )
        break
      }
      await sleep(15_000)
      const row = await client.get<DatasetEnvelope>(datasetId)
      if (!row.ok) {
        log(`WARN: poll → ${row.status} ${row.error}`)
        continue
      }
      if (row.body.dataset.data_ref === expectedRef && !row.body.dataset.transcoding) {
        log(`transcode landed — data_ref=${expectedRef}`)
        break
      }
      const elapsed = Math.round((Date.now() - started) / 1000)
      if (elapsed - lastHeartbeat >= 60) {
        lastHeartbeat = elapsed
        log(`waiting on transcode… (${elapsed}s elapsed, transcoding=${row.body.dataset.transcoding ? 1 : 0})`)
      }
    }
  }

  const status = await client.postWorkflowRunStatus(args.workflowId, args.runId, {
    status: 'succeeded',
    gha_run_id: args.ghaRunId,
    upload_id: uploadId,
  })
  if (!status.ok) {
    log(`FAIL: succeeded callback → ${status.status} ${status.error}`)
    return 2
  }
  log(`done — run ${args.runId} succeeded`)
  return 0
}

async function phasePublish(client: TerravizClient, args: Args): Promise<number> {
  const workflow = JSON.parse(
    await readFile(join(args.workdir, 'workflow.json'), 'utf-8'),
  ) as WorkflowEnvelope['workflow']
  // Branch on what the pipeline *declares* it produces, not on which
  // files happen to be present: with the frame cache, restored frames
  // almost always exist, so a video pipeline whose compose-video
  // silently failed must NOT fall through to publishing stale frames
  // and reporting success — it has to fail.
  if (expectedOutputKind(workflow.pipeline_json) === 'video') {
    if (!existsSync(args.video)) {
      log(`FAIL: pipeline declares MP4 output but ${args.video} is missing — compose-video did not produce it`)
      return 4
    }
    return await publishVideo(client, args, workflow)
  }
  return await publishFrames(client, args, workflow)
}

/** What artifact the pipeline declares: an MP4 (a stage writes
 *  `WORKFLOW_OUTPUT_PATH`) or a frame sequence (anything else — the
 *  recall-enabled shape). Mirrors the server-side validator's
 *  output check. */
export function expectedOutputKind(pipelineJson: string): 'video' | 'frames' {
  try {
    const parsed = JSON.parse(pipelineJson) as {
      stages?: Array<{ args?: Record<string, unknown> }>
    }
    for (const stage of parsed.stages ?? []) {
      for (const value of Object.values(stage.args ?? {})) {
        if (value === WORKFLOW_OUTPUT_PATH) return 'video'
      }
    }
  } catch {
    /* unparseable — treat as frames-output; the publish leg will
       surface a real error if there's nothing to publish */
  }
  return 'frames'
}

async function publishVideo(
  client: TerravizClient,
  args: Args,
  workflow: WorkflowEnvelope['workflow'],
): Promise<number> {
  const datasetId = workflow.target_dataset_id

  // 1. Preflight (the Verify-stage stand-in).
  const probe = await runFfprobe(args.ffprobeBin, args.video)
  const spec = assessSosSpec(probe)
  log(`ffprobe: ${spec.summary}`)
  for (const w of spec.warnings) log(`WARN: ${w}`)
  for (const f of spec.failures) log(`FAIL: ${f}`)
  if (spec.failures.length > 0) return 3

  // 2. Sidecar → dataset PATCH.
  const sidecarCode = await applyMetadataSidecar(client, args, workflow)
  if (sidecarCode !== null) return sidecarCode

  // 3. Asset init → PUT → complete (overwrite-in-place: same
  //    dataset, fresh upload_id; the transcoding guard 409s if a
  //    previous encode is still in flight).
  const bytes = await readFile(args.video)
  const size = (await stat(args.video)).size
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  log(`source: ${size} bytes, ${digest}`)

  const init = await client.initAssetUpload<AssetInitResponse>(datasetId, {
    kind: 'data',
    mime: 'video/mp4',
    size,
    content_digest: digest,
  })
  if (!init.ok) {
    log(`FAIL: asset init → ${init.status} ${init.error}`)
    return 4
  }
  const uploadId = init.body.upload_id
  log(`upload ${uploadId} initiated (mock=${init.body.mock === true})`)

  if (init.body.mock === true) {
    log('mock mode — skipping the byte PUT')
  } else if (init.body.r2) {
    const put = await client.uploadBytes(
      'r2',
      init.body.r2.url,
      init.body.r2.headers,
      bytes,
      'video/mp4',
      'dataset.mp4',
    )
    if (!put.ok) {
      log(`FAIL: presigned PUT → ${put.status} ${put.message ?? ''}`)
      return 4
    }
  } else {
    log('FAIL: init response carried no r2 target')
    return 4
  }

  const complete = await completeWithRetry(client, datasetId, uploadId)
  if (!complete.ok) {
    log(`FAIL: complete → ${complete.status} ${complete.error ?? ''}`)
    return 4
  }
  log('complete ok — transcode dispatch fired')

  // 4. Wait for the transcode to flip data_ref, then report.
  return await waitAndReportSucceeded(client, args, datasetId, uploadId)
}

/**
 * Publish the run's padded frame sequence via the image-sequence
 * asset path (`docs/ZYRA_INTEGRATION_PLAN.md` §Real-time frame store
 * stage 3). The transcode builds the same HLS bundle the MP4 path
 * would AND sets the frame columns that light up `/frames`, so
 * recall comes for free. No ffprobe preflight here — there's no MP4
 * to probe; the transcode enforces the output spec.
 */
async function publishFrames(
  client: TerravizClient,
  args: Args,
  workflow: WorkflowEnvelope['workflow'],
): Promise<number> {
  const datasetId = workflow.target_dataset_id
  const { framesDir } = deriveFrameParams(workflow.pipeline_json, args.workdir)
  log(`no MP4 at ${args.video} — publishing frame sequence from ${framesDir}`)

  // 1. Sidecar first — sets the start_time / period the /frames
  //    surface needs to render per-frame timestamps.
  const sidecarCode = await applyMetadataSidecar(client, args, workflow)
  if (sidecarCode !== null) return sidecarCode

  // 2. Hash → init → PUT frames + manifest → complete (fires the
  //    transcode). Frames are content-addressed
  //    (`docs/INCREMENTAL_FRAME_UPLOAD_PLAN.md`), so when R2 creds are
  //    present we HEAD-skip frames already in the shared store and PUT
  //    only the delta — a scheduled re-publish uploads the day's new
  //    frames, not the whole window.
  const r2 = frameCacheConfig()
  // Capture the digests of the manifest the row advertises RIGHT NOW —
  // before this run's transcode swaps it — as the GC grace set. This is
  // the prior window the live `/frames` recall is still serving; reading
  // it up front (rather than at GC time) makes the prune race-proof:
  // even if the transcode completes during the publish wait below, the
  // prior frames are already pinned for a one-run grace window.
  const priorDigests = r2 ? await fetchAdvertisedFrameDigests(client, r2, datasetId) : []

  let uploadId: string
  let currentDigests: string[] = []
  try {
    const result = await publishFrameSequence(client, datasetId, framesDir, {
      log,
      exists: r2 ? key => r2ObjectExists(r2, key) : undefined,
    })
    uploadId = result.uploadId
    currentDigests = result.digests
    log(
      `frame sequence upload ${uploadId} (${result.frameCount} frames: ` +
        `${result.uploaded} uploaded, ${result.reused} reused, mock=${result.mock}) — transcode dispatch fired`,
    )
  } catch (err) {
    log(`FAIL: frame-sequence publish → ${err instanceof Error ? err.message : String(err)}`)
    return 4
  }

  // 3. Wait for the transcode to flip data_ref, then report.
  const code = await waitAndReportSucceeded(client, args, datasetId, uploadId)

  // 4. GC the content-addressed frame store (best-effort — never
  //    changes the run's outcome). Keep this run's frames ∪ the prior
  //    window captured above (the one-run grace window).
  if (code === 0 && r2) {
    await gcFrameStore(r2, datasetId, [...currentDigests, ...priorDigests])
  }
  return code
}

/**
 * Read the digests of whatever frame manifest the dataset row currently
 * advertises (`frame_source_filenames_ref`). Called at publish start so
 * the value is the PRIOR window (the bundle `/frames` recall is serving
 * before this run's transcode swaps it in) — the grace set the frame GC
 * must keep so an in-flight reader on the prior manifest doesn't lose
 * frames mid-enumeration.
 *
 * Best-effort: returns [] (no grace contribution) on any miss — a
 * missing row, no prior frames, an unreadable or unparseable manifest.
 * This run's own digests still protect the just-published frames.
 */
async function fetchAdvertisedFrameDigests(
  client: TerravizClient,
  r2: R2UploadConfig,
  datasetId: string,
): Promise<string[]> {
  try {
    const row = await client.get<DatasetEnvelope>(datasetId)
    const ref = row.ok ? row.body.dataset.frame_source_filenames_ref : null
    if (!ref) return []
    const manifestKey = ref.startsWith('r2:') ? ref.slice('r2:'.length) : ref
    const blob = await getR2ObjectText(r2, manifestKey)
    if (!blob) return []
    const entries = JSON.parse(blob) as Array<{ digest?: unknown }>
    return entries
      .filter((e): e is { digest: string } => typeof e.digest === 'string')
      .map(e => e.digest)
  } catch (err) {
    log(`WARN: frame GC — could not read the prior manifest for the grace set (${err instanceof Error ? err.message : String(err)})`)
    return []
  }
}

/**
 * Mark-and-sweep the shared content-addressed frame store
 * (`docs/INCREMENTAL_FRAME_UPLOAD_PLAN.md` §GC). `keepDigests` is this
 * run's frames ∪ the prior window captured at publish start, so every
 * frame either the new bundle or the still-serving prior bundle
 * references survives; the rest (frames that slid off ≥2 windows ago)
 * is reclaimed. Fully best-effort: any failure logs and returns without
 * affecting the run, exactly like `pruneSegments` in the HLS path.
 */
async function gcFrameStore(
  r2: R2UploadConfig,
  datasetId: string,
  keepDigests: string[],
): Promise<void> {
  try {
    const keys = await listR2KeysPaginated(r2, frameStorePrefix(datasetId))
    const hexToKey = new Map<string, string>()
    for (const k of keys) {
      const hex = frameHexFromKey(k)
      if (hex) hexToKey.set(hex, k)
    }
    const orphanHexes = selectFrameOrphans([...hexToKey.keys()], keepDigests)
    if (orphanHexes.length === 0) {
      log(`frame GC: nothing to prune (${hexToKey.size} frame(s) all referenced)`)
      return
    }
    let deleted = 0
    for (const hex of orphanHexes) {
      const key = hexToKey.get(hex)
      if (!key) continue
      try {
        await deleteR2Object(r2, key)
        deleted++
      } catch (err) {
        log(`WARN: frame GC delete ${key} failed (continuing) — ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    log(`frame GC: pruned ${deleted}/${orphanHexes.length} orphaned frame(s), kept ${hexToKey.size - deleted}`)
  } catch (err) {
    log(`WARN: frame GC failed (continuing) — ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** R2 frame-cache config from the runner env, or null when the
 *  operator hasn't wired the credential trio — in which case the
 *  cache is simply disabled and the run proceeds uncached. */
function frameCacheConfig(): R2UploadConfig | null {
  const cfg = loadR2ConfigFromEnv()
  if (!cfg.endpoint || !cfg.accessKeyId || !cfg.secretAccessKey) return null
  return cfg
}

/** Translate a pipeline `/work/...` path (the container's view of
 *  the mounted workdir) to the host path the CLI sees. Returns null
 *  when the path is absent or points outside the mounted workdir, so
 *  a caller can tell "absent" from "present" instead of guessing. */
function mapWorkFile(pipelinePath: string | null, workdir: string): string | null {
  if (!pipelinePath) return null
  if (pipelinePath === '/work') return workdir
  if (pipelinePath.startsWith('/work/')) return join(workdir, pipelinePath.slice('/work/'.length))
  return null
}

/** Where a pipeline that declares no sync-dir of its own leaves its
 *  frames. `/validate` requires every stored pipeline to write to
 *  `WORKFLOW_OUTPUT_PATH` or `WORKFLOW_FRAMES_OUTPUT_DIR`
 *  (`functions/api/v1/_lib/workflow-validators.ts`), so a
 *  frames-output pipeline's frames are there by contract — deriving
 *  the fallback from the constant keeps the runner and the validator
 *  from drifting apart. */
function framesOutputDir(workdir: string): string {
  // The constant is a `/work/...` path by construction, so the
  // mapping cannot fail; the fallback is a guard against a future
  // edit to it silently yielding null here.
  return mapWorkFile(WORKFLOW_FRAMES_OUTPUT_DIR, workdir) ?? join(workdir, 'images', 'frames')
}

export interface FrameParams {
  /** Host path to the directory the run's frames land in: the acquire
   *  stage's `--sync-dir` when it declares one under `/work`, else
   *  `WORKFLOW_FRAMES_OUTPUT_DIR`. Always a path — the image-sequence
   *  publish path has to read from somewhere. */
  framesDir: string
  /** The same directory *as a cache participant* — null unless the
   *  pipeline declares an `acquire --sync-dir` under `/work`. See
   *  `deriveFrameParams` for why the two differ. */
  cacheDir: string | null
  /** Window budget for the prune, or null to keep everything. */
  keepFrames: number | null
  /** Host path to the pad-missing JSON report, or null when the
   *  pipeline has no pad-missing stage with a `json-report` arg. */
  padReportPath: string | null
}

/** Derive the frames directory + window budget + pad-report path
 *  from the stored pipeline definition: the acquire stage's
 *  `sync-dir` + `since-period`, a scan-frames/metadata stage's
 *  `period-seconds`, and the pad-missing stage's `json-report`.
 *
 *  `framesDir` and `cacheDir` are the same path when the pipeline
 *  declares a sync-dir, and diverge when it doesn't: reading frames
 *  the run produced is always possible (the runner has a conventional
 *  location), but *caching* them is only meaningful for a pipeline
 *  built around `acquire --sync-dir`. That stage is the entire reason
 *  the cache exists — it is what skips a re-fetch when the frame is
 *  already on disk. A pipeline without one regenerates every frame
 *  from source each run, so restoring a cached frame into its output
 *  directory cannot save any work; it can only leave behind a file
 *  the run did not produce, which `compose-video --glob` then folds
 *  into the video. Defaulting `cacheDir` to `<workdir>/images/frames`
 *  made every such pipeline an unwilling cache participant. */
export function deriveFrameParams(pipelineJson: string, workdir: string): FrameParams {
  let stages: Array<Record<string, unknown>> = []
  try {
    const parsed = JSON.parse(pipelineJson) as { stages?: unknown }
    if (Array.isArray(parsed.stages)) stages = parsed.stages as Array<Record<string, unknown>>
  } catch {
    /* unparseable pipeline — fall back to defaults below */
  }
  let syncDir: string | null = null
  let sincePeriod: string | null = null
  let periodSeconds: number | null = null
  let padReport: string | null = null
  for (const stage of stages) {
    const args = (stage.args ?? {}) as Record<string, unknown>
    if (stage.stage === 'acquire') {
      syncDir = pipelineArgString(args, 'sync-dir') ?? syncDir
      sincePeriod = pipelineArgString(args, 'since-period') ?? sincePeriod
    }
    if (stage.command === 'scan-frames' || stage.command === 'metadata') {
      const ps = pipelineArg(args, 'period-seconds')
      if (typeof ps === 'number') periodSeconds = ps
      else if (typeof ps === 'string' && /^\d+$/.test(ps)) periodSeconds = Number(ps)
    }
    if (stage.command === 'pad-missing') {
      padReport = pipelineArgString(args, 'json-report') ?? padReport
    }
  }
  const cacheDir = mapWorkFile(syncDir, workdir)
  return {
    framesDir: cacheDir ?? framesOutputDir(workdir),
    cacheDir,
    keepFrames: windowFrameBudget(
      sincePeriod ? isoDurationToSeconds(sincePeriod) : null,
      periodSeconds,
    ),
    padReportPath: mapWorkFile(padReport, workdir),
  }
}

/**
 * Locate the data-encoded colour-scale sidecar the pipeline declares,
 * or `null` for an ordinary colourised pipeline.
 *
 * The third scraper over the stored pipeline, alongside
 * `expectedOutputKind` and `deriveFrameParams`. The signal is the
 * `visualize heatmap` stage's own `--data-encoded` / `--color-scale-file`
 * args, so the pipeline that produced the frames is the single source
 * of truth for how they are encoded — nothing has to be declared twice
 * or kept in sync. Pipeline arg *keys* aren't allowlisted
 * (`workflow-validators.ts` checks only stage/command pairs and value
 * shape), so this needed no validator change.
 *
 * Both args are required together. `--data-encoded` without a sidecar
 * would publish frames whose luma is a measurement with nothing saying
 * what it measures — they would render as raw grayscale — so that
 * combination is treated as "not data-encoded" and warned about rather
 * than half-applied.
 */
/**
 * Read a pipeline arg by its canonical kebab name, accepting the
 * snake_case spelling too.
 *
 * zyra's `pipeline_runner` builds the CLI flag with
 * `"--" + k.replace("_", "-")`, so `cmap_file` and `cmap-file` both
 * become `--cmap-file` and both are legitimate in a stored pipeline.
 * Nothing normalises the JSON on the way in, so whichever the author
 * typed is what lands in the row — and a scraper that knows only one
 * spelling silently sees nothing. The published RRFS workflow is
 * written in snake_case throughout, so that is not a hypothetical.
 */
function pipelineArg(args: Record<string, unknown>, name: string): unknown {
  const direct = args[name]
  if (direct !== undefined) return direct
  return args[name.replace(/-/g, '_')]
}

/** `pipelineArg` narrowed to a string, or null. */
function pipelineArgString(args: Record<string, unknown>, name: string): string | null {
  const v = pipelineArg(args, name)
  return typeof v === 'string' ? v : null
}

export function deriveColorScalePath(pipelineJson: string, workdir: string): string | null {
  let stages: Array<Record<string, unknown>> = []
  try {
    const parsed = JSON.parse(pipelineJson) as { stages?: unknown }
    if (Array.isArray(parsed.stages)) stages = parsed.stages as Array<Record<string, unknown>>
  } catch {
    return null
  }
  let dataEncoded = false
  let scalePath: string | null = null
  for (const stage of stages) {
    if (stage.command !== 'heatmap') continue
    const args = (stage.args ?? {}) as Record<string, unknown>
    // Flag-style args can arrive as `true` or as an empty string
    // depending on how the pipeline was authored; both mean "present".
    const flag = pipelineArg(args, 'data-encoded')
    if (flag === true || flag === '' || flag === 'true') dataEncoded = true
    scalePath = pipelineArgString(args, 'color-scale-file') ?? scalePath
  }
  if (!dataEncoded) return null
  if (!scalePath) {
    log('WARN: pipeline declares --data-encoded with no --color-scale-file — publishing as a picture')
    return null
  }
  return mapWorkFile(scalePath, workdir)
}

/**
 * Read and validate the sidecar, returning the row fields to PATCH.
 *
 * Validated here rather than trusted, because the publisher API will
 * refuse a malformed pair anyway and a run that fails at the PATCH is
 * far harder to diagnose than one that says so at the source. Returns
 * `{}` on any problem — the dataset publishes as the picture it
 * visibly is, rather than the run failing outright over a palette.
 */
export async function readColorScaleFields(
  scalePath: string | null,
): Promise<Record<string, string>> {
  if (!scalePath) return {}
  let raw: string
  try {
    raw = await readFile(scalePath, 'utf-8')
  } catch {
    log(`WARN: color-scale sidecar ${scalePath} is unreadable — publishing as a picture`)
    return {}
  }
  if (raw.length > COLOR_SCALE_MAX_CHARS) {
    log(
      `WARN: color-scale sidecar is ${raw.length} chars (max ${COLOR_SCALE_MAX_CHARS}) — ` +
        'publishing as a picture',
    )
    return {}
  }
  if (parseColorScale(raw) === null) {
    log(`WARN: color-scale sidecar ${scalePath} failed validation — publishing as a picture`)
    return {}
  }
  log(`color-scale sidecar: ${scalePath} (${raw.length} chars)`)
  return { render_encoding: RENDER_ENCODING_DATA_LUMA, color_scale: raw }
}

/**
 * Read the synthetic-frame filenames from a `pad-missing` JSON
 * report (`created_files` — absolute paths whose basenames are the
 * frame filenames). Returns [] when the report is absent, malformed,
 * or a dry run — fail-open so a missing report never deletes real
 * cache data.
 */
export async function readPaddedFrameNames(reportPath: string): Promise<string[]> {
  try {
    const report = JSON.parse(await readFile(reportPath, 'utf-8')) as {
      created_files?: unknown
      dry_run?: unknown
    }
    if (report.dry_run === true || !Array.isArray(report.created_files)) return []
    return report.created_files
      .filter((f): f is string => typeof f === 'string')
      .map(f => basename(f))
  } catch {
    return []
  }
}

/** Read the dataset id + pipeline definition the fetch phase wrote.
 *  Returns null (logging a warning) when the file is absent or
 *  malformed — the frame-cache phases treat that as "skip", never
 *  as a run failure. */
async function readWorkflowForFrames(
  workdir: string,
): Promise<{ datasetId: string; pipelineJson: string } | null> {
  try {
    const wf = JSON.parse(await readFile(join(workdir, 'workflow.json'), 'utf-8')) as {
      target_dataset_id?: unknown
      pipeline_json?: unknown
    }
    if (typeof wf.target_dataset_id !== 'string' || typeof wf.pipeline_json !== 'string') {
      log('WARN: workflow.json missing target_dataset_id / pipeline_json — skipping frame cache')
      return null
    }
    return { datasetId: wf.target_dataset_id, pipelineJson: wf.pipeline_json }
  } catch (err) {
    log(`WARN: cannot read workflow.json — skipping frame cache (${err instanceof Error ? err.message : String(err)})`)
    return null
  }
}

/** restore-frames: pull the dataset's cached frames into the
 *  workdir before the Zyra container runs. Best-effort — a cache
 *  miss or R2 error logs and returns 0 so the run continues. */
async function phaseRestoreFrames(args: Args): Promise<number> {
  const cfg = frameCacheConfig()
  if (!cfg) {
    log('frame cache disabled (R2 not configured) — skipping restore')
    return 0
  }
  const wf = await readWorkflowForFrames(args.workdir)
  if (!wf) return 0
  const { cacheDir } = deriveFrameParams(wf.pipelineJson, args.workdir)
  if (!cacheDir) {
    log('frame cache: pipeline has no `acquire --sync-dir` — skipping restore')
    return 0
  }
  try {
    const result = await restoreFramesFromR2(cfg, wf.datasetId, cacheDir, { log })
    log(`frame cache: restored ${result.restored}, ${result.skipped} already present → ${cacheDir}`)
  } catch (err) {
    log(`WARN: frame restore failed (continuing uncached) — ${err instanceof Error ? err.message : String(err)}`)
  }
  return 0
}

/** save-frames: push new frames back to the cache after compose and
 *  prune the cache to the active window. Best-effort — failing to
 *  cache must not fail a run that already produced a video. */
async function phaseSaveFrames(args: Args): Promise<number> {
  const cfg = frameCacheConfig()
  if (!cfg) {
    log('frame cache disabled (R2 not configured) — skipping save')
    return 0
  }
  const wf = await readWorkflowForFrames(args.workdir)
  if (!wf) return 0
  const { cacheDir, keepFrames, padReportPath } = deriveFrameParams(wf.pipelineJson, args.workdir)
  if (!cacheDir) {
    // Restore skipped for the same reason, so there is nothing new to
    // push. Drop whatever a prior (pre-gating) run left under this
    // dataset's prefix: it is unreachable now and would otherwise sit
    // in R2 forever, waiting to contaminate the pipeline again if it
    // ever gains a sync-dir.
    log('frame cache: pipeline has no `acquire --sync-dir` — skipping save')
    try {
      await purgeFramesFromR2(cfg, wf.datasetId, { log })
    } catch (err) {
      log(`WARN: frame purge failed (continuing) — ${err instanceof Error ? err.message : String(err)}`)
    }
    return 0
  }
  // Synthetic frames (pad-missing's created_files) stay out of the
  // cache so the next run's acquire can replace them with real ones.
  const excludeNames = padReportPath ? await readPaddedFrameNames(padReportPath) : []
  try {
    const result = await saveFramesToR2(cfg, wf.datasetId, cacheDir, {
      log,
      keepFrames: keepFrames ?? undefined,
      excludeNames,
    })
    log(
      `frame cache: ${result.uploaded} uploaded, ${result.pruned} pruned, ${result.kept} kept` +
        (keepFrames ? ` (window ${keepFrames})` : ' (no window prune)') +
        (excludeNames.length ? ` (${excludeNames.length} synthetic kept out)` : ''),
    )
  } catch (err) {
    log(`WARN: frame save failed (continuing) — ${err instanceof Error ? err.message : String(err)}`)
  }
  return 0
}

async function phaseReportFailure(client: TerravizClient, args: Args): Promise<number> {
  const status = await client.postWorkflowRunStatus(args.workflowId, args.runId, {
    status: args.terminalStatus,
    gha_run_id: args.ghaRunId,
    error_summary: sanitizeErrorSummary(args.errorSummary),
  })
  if (!status.ok) {
    // A 409 here means the run already reached a terminal status
    // (e.g. publish failed AFTER reporting) — that's fine.
    if (status.status === 409) {
      log(`${args.terminalStatus} callback skipped — run already terminal`)
      return 0
    }
    log(`FAIL: failed callback → ${status.status} ${status.error}`)
    return 2
  }
  log(`run ${args.runId} marked ${args.terminalStatus}`)
  return 0
}

/** Read the target dataset id the fetch phase stored in
 *  workflow.json. Returns null (not an error) when the file is absent
 *  or malformed — the soft-pass then can't confirm a published bundle
 *  and escalates. */
async function readTargetDatasetId(workdir: string): Promise<string | null> {
  try {
    const wf = JSON.parse(await readFile(join(workdir, 'workflow.json'), 'utf-8')) as {
      target_dataset_id?: unknown
    }
    return typeof wf.target_dataset_id === 'string' ? wf.target_dataset_id : null
  } catch {
    return null
  }
}

/**
 * acquire-softpass: the workflow calls this after `zyra run` has
 * failed (and exhausted its retries) to decide whether the failure is
 * a soft-passable transient NOAA-FTP `acquire` hiccup. See
 * `cli/lib/zyra-acquire-softpass.ts` for the decision logic.
 *
 *   - Soft-pass (transient acquire failure + fresh published bundle):
 *     POST a no-op `succeeded` and exit 0, so the run finishes GREEN
 *     with no false-positive failure notification. The workflow gates
 *     its publish steps off this outcome (no new data was produced).
 *   - Escalate (anything else — a non-acquire failure, a
 *     never-published dataset, or a stale bundle = sustained outage):
 *     exit non-zero WITHOUT posting, so the workflow's `if: failure()`
 *     step posts `failed` and the operator is notified.
 */
async function phaseAcquireSoftpass(client: TerravizClient, args: Args): Promise<number> {
  // 1. Classify the captured `zyra run` output.
  let logText = ''
  if (args.zyraLog) {
    try {
      logText = await readFile(args.zyraLog, 'utf-8')
    } catch (err) {
      log(
        `WARN: cannot read zyra log ${args.zyraLog} — cannot confirm an acquire failure (${err instanceof Error ? err.message : String(err)})`,
      )
    }
  } else {
    log('WARN: no --zyra-log provided — cannot confirm an acquire failure')
  }
  const classification = classifyZyraFailure(logText)

  // 2. Resolve the dataset's published-bundle state for the freshness
  //    check.
  const datasetId = await readTargetDatasetId(args.workdir)
  let dataRef: string | null | undefined
  let endTime: string | null | undefined
  let updatedAt: string | null | undefined
  if (datasetId) {
    const row = await client.get<DatasetEnvelope>(datasetId)
    if (row.ok) {
      dataRef = row.body.dataset.data_ref
      endTime = row.body.dataset.end_time
      updatedAt = row.body.dataset.updated_at
    } else {
      log(`WARN: dataset GET → ${row.status} ${row.error} — treating as unpublished (will escalate)`)
    }
  } else {
    log('WARN: no target_dataset_id in workflow.json — treating as unpublished (will escalate)')
  }

  const freshness = assessBundleFreshness({
    dataRef,
    endTime,
    updatedAt,
    nowMs: Date.now(),
    staleAfterSeconds: args.staleAfterSeconds,
  })
  const decision = decideAcquireSoftPass({ classification, freshness })
  log(decision.reason)

  if (!decision.softPass) {
    // Escalate: leave the `failed` callback to the workflow's
    // if: failure() step. Non-zero exit fails the job.
    log(`run ${args.runId} NOT soft-passed — failing the job`)
    return 2
  }

  // Soft-pass: land a terminal `succeeded` (no upload_id — nothing was
  // published this tick).
  const status = await client.postWorkflowRunStatus(args.workflowId, args.runId, {
    status: 'succeeded',
    gha_run_id: args.ghaRunId,
  })
  if (!status.ok) {
    // A 409 means the run already reached a terminal status — fine.
    if (status.status === 409) {
      log('soft-pass callback skipped — run already terminal')
      return 0
    }
    log(`FAIL: soft-pass succeeded callback → ${status.status} ${status.error}`)
    return 2
  }
  log(`run ${args.runId} soft-passed (no new data this tick; prior bundle preserved)`)
  return 0
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  if ('error' in parsed) {
    console.error(`error: ${parsed.error}`)
    return 1
  }
  // The frame-cache phases talk only to R2, not the publisher API,
  // so they don't need (and shouldn't require) the TerravizClient
  // config to be present.
  if (parsed.phase === 'restore-frames') return await phaseRestoreFrames(parsed)
  if (parsed.phase === 'save-frames') return await phaseSaveFrames(parsed)

  const client = new TerravizClient(resolveConfig())
  try {
    switch (parsed.phase) {
      case 'fetch':
        return await phaseFetch(client, parsed)
      case 'publish':
        return await phasePublish(client, parsed)
      case 'report-failure':
        return await phaseReportFailure(client, parsed)
      case 'acquire-softpass':
        return await phaseAcquireSoftpass(client, parsed)
    }
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    return parsed.phase === 'publish' ? 4 : 2
  }
}

// Only run when invoked directly; tests import the named helpers.
const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url === `file://${process.argv[1]}`
if (invokedDirectly) {
  // Same top-level rejection guard the spike CLI grew in PR #175
  // review: a throw outside main()'s own try (bad argv state,
  // unreadable workdir) still exits non-zero with a readable
  // message rather than an unhandled-rejection crash.
  void main()
    .then(code => process.exit(code))
    .catch((err: unknown) => {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    })
}
