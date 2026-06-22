#!/usr/bin/env -S npx tsx
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
 *   5 — transcode wait timeout (upload landed; encode didn't finish)
 */

import { createHash } from 'node:crypto'
import { readFile, writeFile, stat, mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfig } from './lib/config'
import { TerravizClient } from './lib/client'
import { assessSosSpec, runFfprobe } from './lib/sos-spec'
import {
  buildRunVars,
  renderSidecar,
  sanitizeErrorSummary,
} from './lib/workflow-sidecar'
import { loadR2ConfigFromEnv, type R2UploadConfig } from './lib/r2-upload'
import {
  isoDurationToSeconds,
  restoreFramesFromR2,
  saveFramesToR2,
  windowFrameBudget,
} from './lib/r2-frames'
import { publishFrameSequence } from './lib/frames-publish'

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

export type Phase = 'fetch' | 'publish' | 'report-failure' | 'restore-frames' | 'save-frames'

export interface Args {
  phase: Phase
  workflowId: string
  runId: string
  workdir: string
  ghaRunId: string | null
  video: string
  waitSeconds: number
  errorSummary: string
  ffprobeBin: string
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
    phase !== 'restore-frames' &&
    phase !== 'save-frames'
  ) {
    return {
      error: `--phase must be fetch, publish, report-failure, restore-frames, or save-frames; got ${phase ?? '(missing)'}`,
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
  return {
    phase,
    workflowId,
    runId,
    workdir,
    ghaRunId: get('gha-run-id'),
    video: get('video') ?? join(workdir, 'output', 'dataset.mp4'),
    waitSeconds,
    errorSummary: get('error-summary') ?? 'Workflow run failed (no detail provided).',
    ffprobeBin: get('ffprobe-bin') ?? 'ffprobe',
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
  dataset: { id: string; data_ref?: string | null; transcoding?: number | null }
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

async function phaseFetch(client: TerravizClient, args: Args): Promise<number> {
  const result = await client.getWorkflow<WorkflowEnvelope>(args.workflowId)
  if (!result.ok) {
    log(`FAIL: fetch workflow → ${result.status} ${result.error}`)
    return 2
  }
  const workflow = result.body.workflow
  await mkdir(args.workdir, { recursive: true })
  await mkdir(join(args.workdir, 'output'), { recursive: true })
  await writeFile(join(args.workdir, 'pipeline.json'), workflow.pipeline_json)
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
  if (Object.keys(sidecar.fields).length > 0) {
    const patched = await client.updateDataset(workflow.target_dataset_id, sidecar.fields)
    if (!patched.ok) {
      log(`FAIL: dataset PATCH → ${patched.status} ${patched.error}`)
      return 2
    }
    log(`dataset ${workflow.target_dataset_id} metadata updated (${Object.keys(sidecar.fields).join(', ')})`)
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
    const deadline = Date.now() + args.waitSeconds * 1000
    const expectedRef = `r2:videos/${datasetId}/${uploadId}/master.m3u8`
    for (;;) {
      if (Date.now() > deadline) {
        log(`TIMEOUT: transcode did not finish within ${args.waitSeconds}s`)
        return 5
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
  // Branch on what the pipeline produced: a composed MP4, or a frame
  // sequence (recall-enabled templates drop `compose-video` and
  // leave their padded frames on disk for the image-sequence path).
  return existsSync(args.video)
    ? await publishVideo(client, args, workflow)
    : await publishFrames(client, args, workflow)
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
  //    transcode).
  let uploadId: string
  try {
    const result = await publishFrameSequence(client, datasetId, framesDir, { log })
    uploadId = result.uploadId
    log(`frame sequence upload ${uploadId} (${result.frameCount} frames, mock=${result.mock}) — transcode dispatch fired`)
  } catch (err) {
    log(`FAIL: frame-sequence publish → ${err instanceof Error ? err.message : String(err)}`)
    return 4
  }

  // 3. Wait for the transcode to flip data_ref, then report.
  return await waitAndReportSucceeded(client, args, datasetId, uploadId)
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
 *  the mounted workdir) to the host path the CLI sees. */
function mapWorkPath(pipelinePath: string | null, workdir: string): string {
  if (!pipelinePath) return join(workdir, 'images', 'frames')
  if (pipelinePath === '/work') return workdir
  if (pipelinePath.startsWith('/work/')) return join(workdir, pipelinePath.slice('/work/'.length))
  return join(workdir, 'images', 'frames')
}

interface FrameParams {
  framesDir: string
  /** Window budget for the prune, or null to keep everything. */
  keepFrames: number | null
}

/** Derive the frames directory + window budget from the stored
 *  pipeline definition: the acquire stage's `sync-dir` +
 *  `since-period`, and a scan-frames/metadata stage's
 *  `period-seconds`. */
function deriveFrameParams(pipelineJson: string, workdir: string): FrameParams {
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
  for (const stage of stages) {
    const args = (stage.args ?? {}) as Record<string, unknown>
    if (stage.stage === 'acquire') {
      if (typeof args['sync-dir'] === 'string') syncDir = args['sync-dir']
      if (typeof args['since-period'] === 'string') sincePeriod = args['since-period']
    }
    if (stage.command === 'scan-frames' || stage.command === 'metadata') {
      const ps = args['period-seconds']
      if (typeof ps === 'number') periodSeconds = ps
      else if (typeof ps === 'string' && /^\d+$/.test(ps)) periodSeconds = Number(ps)
    }
  }
  return {
    framesDir: mapWorkPath(syncDir, workdir),
    keepFrames: windowFrameBudget(
      sincePeriod ? isoDurationToSeconds(sincePeriod) : null,
      periodSeconds,
    ),
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
  const { framesDir } = deriveFrameParams(wf.pipelineJson, args.workdir)
  try {
    const result = await restoreFramesFromR2(cfg, wf.datasetId, framesDir, { log })
    log(`frame cache: restored ${result.restored}, ${result.skipped} already present → ${framesDir}`)
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
  const { framesDir, keepFrames } = deriveFrameParams(wf.pipelineJson, args.workdir)
  try {
    const result = await saveFramesToR2(cfg, wf.datasetId, framesDir, {
      log,
      keepFrames: keepFrames ?? undefined,
    })
    log(
      `frame cache: ${result.uploaded} uploaded, ${result.pruned} pruned, ${result.kept} kept` +
        (keepFrames ? ` (window ${keepFrames})` : ' (no window prune)'),
    )
  } catch (err) {
    log(`WARN: frame save failed (continuing) — ${err instanceof Error ? err.message : String(err)}`)
  }
  return 0
}

async function phaseReportFailure(client: TerravizClient, args: Args): Promise<number> {
  const status = await client.postWorkflowRunStatus(args.workflowId, args.runId, {
    status: 'failed',
    gha_run_id: args.ghaRunId,
    error_summary: sanitizeErrorSummary(args.errorSummary),
  })
  if (!status.ok) {
    // A 409 here means the run already reached a terminal status
    // (e.g. publish failed AFTER reporting) — that's fine.
    if (status.status === 409) {
      log('failed callback skipped — run already terminal')
      return 0
    }
    log(`FAIL: failed callback → ${status.status} ${status.error}`)
    return 2
  }
  log(`run ${args.runId} marked failed`)
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
