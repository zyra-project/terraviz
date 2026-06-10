#!/usr/bin/env -S npx tsx
/**
 * `zyra-spike-publish` — Phase Z0 spike (docs/ZYRA_INTEGRATION_PLAN.md).
 *
 * The TerraViz leg of the Z0 spike: takes an MP4 that a Zyra
 * pipeline (NOAA-GSL/zyra-scheduler) just rendered on the runner,
 * asserts it against the SOS spec with ffprobe, and carries it
 * through the publish API exactly the way the portal's asset
 * uploader would — create draft (or reuse an existing row), init
 * asset upload, PUT to the presigned URL, complete (which fires
 * the existing transcode-hls dispatch), then poll until the
 * transcode flips `data_ref`.
 *
 * Spike code: throwaway allowed per the plan doc. The shape it
 * proves (ffprobe preflight → TerravizClient sequence → poll)
 * graduates into `cli/zyra-publish-from-dispatch.ts` in Phase Z1;
 * the file itself does not.
 *
 * Environment (same resolution as every `terraviz` command —
 * see `cli/lib/config.ts`):
 *
 *   TERRAVIZ_SERVER                — publish API base URL.
 *   TERRAVIZ_ACCESS_CLIENT_ID      — Access service-token id.
 *   TERRAVIZ_ACCESS_CLIENT_SECRET  — Access service-token secret.
 *   TERRAVIZ_INSECURE_LOCAL        — dev mode against
 *                                     DEV_BYPASS_ACCESS deploys.
 *
 * Flags:
 *
 *   --video=<path>          Required. The MP4 the Zyra stage wrote.
 *   --dataset-id=<ULID>     Optional. Reuse an existing draft row
 *                            (the overwrite-in-place path). When
 *                            absent a fresh draft is created.
 *   --title=<string>        Optional. Title for a fresh draft.
 *                            Default: "Zyra Z0 spike — <video name>".
 *   --publish               Optional. Publish the row once the
 *                            transcode lands. Default: leave draft.
 *   --wait-seconds=<n>      Optional. How long to poll for the
 *                            transcode to finish. 0 = fire and
 *                            forget. Default 900.
 *   --frames-meta=<path>    Optional. Zyra's frames-meta.json; when
 *                            present the dataset row's start_time /
 *                            end_time / period are set from it —
 *                            the timing trio real-time datasets
 *                            need for the freshness marker.
 *   --report=<path>         Optional. Also write the markdown
 *                            report here (the GHA workflow cats it
 *                            into $GITHUB_STEP_SUMMARY).
 *   --ffprobe-bin=<path>    Optional. ffprobe binary override.
 *
 * Exit codes (operator-skimmable, same convention as
 * `transcode-from-dispatch.ts`):
 *
 *   0 — success
 *   1 — argument / env validation error
 *   2 — SOS spec assertion failed (hard failure, not warnings)
 *   3 — dataset create / fetch failed
 *   4 — asset init / PUT / complete failed
 *   5 — wait timeout (upload landed; transcode didn't finish in time)
 */

import { createHash } from 'node:crypto'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { resolveConfig } from './lib/config'
import { TerravizClient } from './lib/client'
import { assessSosSpec, runFfprobe } from './lib/sos-spec'
import { readFramesMetaRange, secondsToIsoDuration } from './lib/workflow-sidecar'

// SOS-spec helpers graduated to `cli/lib/sos-spec.ts` when the Z1
// runner landed; re-exported here so the spike's import surface
// (and its tests) stay stable.
export {
  SOS_SPEC,
  assessSosSpec,
  parseFrameRate,
  type ProbeResult,
  type SpecReport,
} from './lib/sos-spec'

// --- Args ---------------------------------------------------------

export interface Args {
  video: string
  datasetId: string | null
  title: string | null
  publish: boolean
  waitSeconds: number
  reportPath: string | null
  framesMetaPath: string | null
  ffprobeBin: string
}

export function parseArgs(argv: readonly string[]): Args | { error: string } {
  const get = (name: string): string | null => {
    const prefix = `--${name}=`
    const match = argv.find(a => a.startsWith(prefix))
    return match ? match.slice(prefix.length) : null
  }
  const has = (name: string): boolean => argv.includes(`--${name}`)

  const video = get('video')
  if (!video) return { error: '--video=<path> is required' }

  const datasetId = get('dataset-id')
  if (datasetId !== null && !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(datasetId)) {
    return { error: `--dataset-id must be a ULID (26 base32 chars); got ${datasetId}` }
  }

  const waitRaw = get('wait-seconds')
  const waitSeconds = waitRaw === null ? 900 : Number(waitRaw)
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 21_600) {
    return { error: `--wait-seconds must be an integer 0..21600; got ${waitRaw}` }
  }

  return {
    video,
    datasetId,
    title: get('title'),
    publish: has('publish'),
    waitSeconds,
    reportPath: get('report'),
    framesMetaPath: get('frames-meta'),
    ffprobeBin: get('ffprobe-bin') ?? 'ffprobe',
  }
}

// --- Wire shapes (subset of the publisher API responses) ----------

interface DatasetEnvelope {
  dataset: { id: string; data_ref?: string | null; transcoding?: number | null }
}

interface AssetInitResponse {
  upload_id: string
  target: 'r2' | 'stream'
  r2?: { method: string; url: string; headers: Record<string, string>; key: string }
  mock?: boolean
}

// --- Main ---------------------------------------------------------

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** POST /complete with retries — the handler's repository_dispatch
 *  call to api.github.com can transiently 5xx (observed live in
 *  spike run 27288385890); complete is safe to retry because a
 *  duplicate dispatch is absorbed by the transcode guard. */
async function completeWithRetry(
  client: TerravizClient,
  datasetId: string,
  uploadId: string,
  note: (line: string) => void,
  attempts = 3,
): Promise<{ ok: boolean; status: number; error?: string }> {
  for (let i = 1; ; i++) {
    const result = await client.completeAssetUpload(datasetId, uploadId)
    if (result.ok) return { ok: true, status: result.status }
    const retryable = result.status === 0 || result.status >= 500
    if (!retryable || i >= attempts) {
      return { ok: false, status: result.status, error: result.error }
    }
    note(`[spike] WARN: complete attempt ${i} → ${result.status} ${result.error}; retrying`)
    await sleep(i * 10_000)
  }
}


async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  if ('error' in parsed) {
    console.error(`error: ${parsed.error}`)
    return 1
  }
  const args = parsed
  const config = resolveConfig()
  const client = new TerravizClient(config)
  const lines: string[] = ['## Zyra Z0 spike — publish report', '']
  const note = (line: string) => {
    console.error(line)
    lines.push(line.replace(/^\[spike\] /, '- '))
  }
  const stepStart = Date.now()
  const elapsed = () => `${((Date.now() - stepStart) / 1000).toFixed(1)}s`

  try {
    // 1. ffprobe spec assertion.
    const probe = await runFfprobe(args.ffprobeBin, args.video)
    const spec = assessSosSpec(probe)
    note(`[spike] ffprobe: ${spec.summary}`)
    for (const w of spec.warnings) note(`[spike] WARN: ${w}`)
    for (const f of spec.failures) note(`[spike] FAIL: ${f}`)
    if (spec.failures.length > 0) {
      note('[spike] SOS spec assertion failed — not uploading')
      return 2
    }

    // 2. Digest + size.
    const bytes = await readFile(args.video)
    const size = (await stat(args.video)).size
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    note(`[spike] source: ${size} bytes, ${digest}`)

    // 3. Create or reuse the dataset row.
    let datasetId = args.datasetId
    if (datasetId === null) {
      const title = args.title ?? `Zyra Z0 spike — ${basename(args.video)}`
      const created = await client.createDataset<DatasetEnvelope>({
        title,
        format: 'video/mp4',
      })
      if (!created.ok) {
        note(`[spike] FAIL: create dataset → ${created.status} ${created.error}`)
        return 3
      }
      datasetId = created.body.dataset.id
      note(`[spike] created draft dataset ${datasetId} ("${title}")`)
    } else {
      const existing = await client.get<DatasetEnvelope>(datasetId)
      if (!existing.ok) {
        note(`[spike] FAIL: fetch dataset ${datasetId} → ${existing.status} ${existing.error}`)
        return 3
      }
      note(`[spike] reusing dataset ${datasetId} (overwrite-in-place path)`)
    }

    // 4. Timing metadata from the pipeline's frames-meta.json —
    //    start/end/period are what the catalog's real-time marker
    //    and timeline run on, so a run that has them must set them.
    if (args.framesMetaPath) {
      try {
        const meta = JSON.parse(await readFile(args.framesMetaPath, 'utf-8')) as unknown
        const range = readFramesMetaRange(meta)
        if (range) {
          const timing: Record<string, unknown> = {
            start_time: range.dataStart,
            end_time: range.dataEnd,
          }
          if (range.periodSeconds) timing.period = secondsToIsoDuration(range.periodSeconds)
          const patched = await client.updateDataset(datasetId, timing)
          if (!patched.ok) {
            const detail = patched.errors
              ? ` ${JSON.stringify(patched.errors)}`
              : patched.message
                ? ` ${patched.message}`
                : ''
            note(`[spike] FAIL: timing PATCH → ${patched.status} ${patched.error}${detail}`)
            return 3
          }
          note(
            `[spike] timing set: start=${range.dataStart} end=${range.dataEnd} period=${(timing.period as string) ?? '(none)'}`,
          )
        } else {
          note(`[spike] WARN: ${args.framesMetaPath} has no recognisable range — timing not set`)
        }
      } catch (err) {
        note(`[spike] WARN: could not read frames-meta: ${err instanceof Error ? err.message : err}`)
      }
    }

    // 5. Asset init → presigned PUT → complete.
    const init = await client.initAssetUpload<AssetInitResponse>(datasetId, {
      kind: 'data',
      mime: 'video/mp4',
      size,
      content_digest: digest,
    })
    if (!init.ok) {
      note(`[spike] FAIL: asset init → ${init.status} ${init.error}`)
      return 4
    }
    const uploadId = init.body.upload_id
    note(`[spike] upload ${uploadId} initiated (target=${init.body.target}, mock=${init.body.mock === true})`)

    if (init.body.mock === true) {
      note('[spike] mock mode — deploy has no real R2 credentials; skipping the byte PUT')
    } else if (init.body.r2) {
      const put = await client.uploadBytes(
        'r2',
        init.body.r2.url,
        init.body.r2.headers,
        bytes,
        'video/mp4',
        basename(args.video),
      )
      if (!put.ok) {
        note(`[spike] FAIL: presigned PUT → ${put.status} ${put.message ?? ''}`)
        return 4
      }
      note(`[spike] PUT ok after ${elapsed()}`)
    } else {
      note('[spike] FAIL: init response carried no r2 target')
      return 4
    }

    const complete = await client.completeAssetUpload<unknown>(datasetId, uploadId)
    if (!complete.ok) {
      note(`[spike] FAIL: complete → ${complete.status} ${complete.error}`)
      return 4
    }
    note('[spike] complete ok — transcode dispatch fired')

    // 5. Poll until the transcode flips data_ref.
    if (args.waitSeconds === 0) {
      note('[spike] --wait-seconds=0 — not waiting for the transcode')
      return 0
    }
    const deadline = Date.now() + args.waitSeconds * 1000
    const expectedRef = `r2:videos/${datasetId}/${uploadId}/master.m3u8`
    for (;;) {
      if (Date.now() > deadline) {
        note(`[spike] TIMEOUT: transcode did not finish within ${args.waitSeconds}s (upload is in; check the transcode-hls run)`)
        return 5
      }
      await sleep(15_000)
      const row = await client.get<DatasetEnvelope>(datasetId)
      if (!row.ok) {
        note(`[spike] WARN: poll → ${row.status} ${row.error}`)
        continue
      }
      const { data_ref, transcoding } = row.body.dataset
      if (data_ref === expectedRef && !transcoding) {
        note(`[spike] transcode landed after ${elapsed()} — data_ref=${data_ref}`)
        break
      }
    }

    // 6. Optional publish.
    if (args.publish) {
      const published = await client.publishDataset<unknown>(datasetId)
      if (!published.ok) {
        note(`[spike] FAIL: publish → ${published.status} ${published.error}`)
        return 3
      }
      note(`[spike] published ${datasetId}`)
    }

    note(`[spike] done in ${elapsed()} — dataset=${datasetId} upload=${uploadId}`)
    return 0
  } finally {
    if (args.reportPath) {
      await writeFile(args.reportPath, lines.join('\n') + '\n').catch(err =>
        console.error(`[spike] WARN: could not write report: ${err}`),
      )
    }
  }
}

// Only run when invoked directly; tests import the named helpers.
const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url === `file://${process.argv[1]}`
if (invokedDirectly) {
  // Catch rejections from main() itself (ffprobe binary missing,
  // unreadable video path, …) so the workflow still gets a non-zero
  // exit with a readable message instead of an unhandled-rejection
  // crash. PR #175 Copilot review.
  void main()
    .then(code => process.exit(code))
    .catch((err: unknown) => {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    })
}
