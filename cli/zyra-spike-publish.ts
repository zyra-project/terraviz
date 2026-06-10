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
import { spawn } from 'node:child_process'
import { resolveConfig } from './lib/config'
import { TerravizClient } from './lib/client'

// --- SOS spec assertion ------------------------------------------

/** The catalog-wide spherical-video invariants the spike asserts.
 *  Width/height are the 4K ladder's top rung (what `encodeHls`
 *  emits); fps is the tour engine's `frameRate` assumption. */
export const SOS_SPEC = {
  width: 4096,
  height: 2048,
  fps: 30,
  codec: 'h264',
  /** 2:1 equirectangular, with a 1% tolerance for odd encoder
   *  roundings. Non-2:1 input renders visibly wrong on the sphere,
   *  so this one is a hard failure rather than a warning. */
  aspectTolerance: 0.01,
} as const

/** The subset of `ffprobe -print_format json` the assertion reads. */
export interface ProbeResult {
  streams?: Array<{
    codec_type?: string
    codec_name?: string
    width?: number
    height?: number
    r_frame_rate?: string
  }>
  format?: { duration?: string }
}

export interface SpecReport {
  /** Hard violations — exit code 2, do not upload. */
  failures: string[]
  /** Soft deviations — the transcode ladder normalises these, so
   *  they're reported for the spike record but don't block. */
  warnings: string[]
  /** Human-readable probe summary for the report. */
  summary: string
}

/** Parse ffprobe's fractional rate strings ("30/1", "30000/1001"). */
export function parseFrameRate(raw: string | undefined): number | null {
  if (!raw) return null
  const match = /^(\d+)\/(\d+)$/.exec(raw)
  if (!match) {
    const plain = Number(raw)
    return Number.isFinite(plain) && plain > 0 ? plain : null
  }
  const num = Number(match[1])
  const den = Number(match[2])
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null
  return num / den
}

export function assessSosSpec(probe: ProbeResult): SpecReport {
  const failures: string[] = []
  const warnings: string[] = []

  const video = probe.streams?.find(s => s.codec_type === 'video')
  if (!video) {
    return {
      failures: ['no video stream found'],
      warnings,
      summary: 'no video stream',
    }
  }

  const width = video.width ?? 0
  const height = video.height ?? 0
  const fps = parseFrameRate(video.r_frame_rate)
  const codec = video.codec_name ?? 'unknown'
  const duration = Number(probe.format?.duration ?? '0')

  if (width <= 0 || height <= 0) {
    failures.push(`unreadable dimensions (${width}x${height})`)
  } else {
    const aspect = width / height
    if (Math.abs(aspect - 2) > 2 * SOS_SPEC.aspectTolerance) {
      failures.push(
        `aspect ratio ${aspect.toFixed(3)} is not 2:1 equirectangular (${width}x${height})`,
      )
    }
    if (width !== SOS_SPEC.width || height !== SOS_SPEC.height) {
      warnings.push(
        `resolution ${width}x${height} differs from the ${SOS_SPEC.width}x${SOS_SPEC.height} ladder top — the transcode upscales/downscales, check source quality`,
      )
    }
  }

  if (!(duration > 0)) {
    failures.push(`duration ${probe.format?.duration ?? '(missing)'} is not positive`)
  }

  if (fps === null) {
    warnings.push('frame rate unreadable from ffprobe output')
  } else if (Math.abs(fps - SOS_SPEC.fps) > 0.01) {
    warnings.push(
      `frame rate ${fps.toFixed(3)} ≠ ${SOS_SPEC.fps} fps — the transcode forces -r ${SOS_SPEC.fps}, playback speed will differ from the source cadence`,
    )
  }

  if (codec !== SOS_SPEC.codec) {
    warnings.push(`codec ${codec} ≠ ${SOS_SPEC.codec} (fine as transcode input)`)
  }

  const summary = `${width}x${height} ${codec} ${fps === null ? '?' : fps.toFixed(2)}fps ${duration.toFixed(1)}s`
  return { failures, warnings, summary }
}

// --- Args ---------------------------------------------------------

export interface Args {
  video: string
  datasetId: string | null
  title: string | null
  publish: boolean
  waitSeconds: number
  reportPath: string | null
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
    ffprobeBin: get('ffprobe-bin') ?? 'ffprobe',
  }
}

// --- ffprobe ------------------------------------------------------

function runFfprobe(bin: string, videoPath: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      bin,
      ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', videoPath],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    let err = ''
    child.stdout.on('data', d => (out += String(d)))
    child.stderr.on('data', d => (err += String(d)))
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited ${code}: ${err.slice(0, 300)}`))
        return
      }
      try {
        resolve(JSON.parse(out) as ProbeResult)
      } catch (e) {
        reject(new Error(`ffprobe output is not JSON: ${e instanceof Error ? e.message : e}`))
      }
    })
  })
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

    // 4. Asset init → presigned PUT → complete.
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
