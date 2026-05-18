#!/usr/bin/env -S npx tsx
/**
 * `transcode-from-dispatch` — invoked by the `transcode-hls` GitHub
 * Actions workflow when the publisher portal fires a
 * `repository_dispatch` after a video upload lands in R2.
 *
 * Per-invocation pipeline:
 *
 *   1. Read `--dataset-id`, `--source-key`, `--source-digest` from
 *      argv (the workflow forwards them from the dispatch's
 *      `client_payload`).
 *   2. Pull the source MP4 from R2 via the S3-compatible API into a
 *      per-run workdir. The publisher's portal upload already
 *      landed at `uploads/{dataset_id}/{upload_id}/source.mp4`;
 *      we read it back here.
 *   3. Re-verify the source digest. Mismatch → fail fast; the
 *      caller's claim was wrong or the R2 object was tampered.
 *   4. `encodeHls` against the 4K + 1080p + 720p 2:1 spherical
 *      ladder shared with `migrate-r2-hls`. Same renditions, same
 *      CRF, same 6-second segments.
 *   5. `uploadHlsBundle` to a per-upload prefix
 *      `videos/{datasetId}/{uploadId}/`. The master.m3u8 lands
 *      at `videos/{datasetId}/{uploadId}/master.m3u8`. Scoping
 *      by upload_id keeps a re-upload to an already-published
 *      row from overwriting the bundle the public manifest is
 *      mid-playback against.
 *   6. POST the publisher API's `transcode-complete` endpoint
 *      with `{ upload_id, source_digest }` using the Cloudflare
 *      Access service-token headers. The handler constructs
 *      `data_ref` server-side from the route id + upload_id,
 *      flips it, and clears `transcoding`.
 *   7. Clean up the workdir on success. Failed runs keep it for
 *      post-mortem unless `--cleanup-on-failure` is set.
 *
 * Environment variables (all required unless noted):
 *
 *   TERRAVIZ_SERVER             — base URL of the Pages deploy
 *                                  (e.g. `https://terraviz.app`).
 *   CF_ACCESS_CLIENT_ID         — Access service-token id.
 *   CF_ACCESS_CLIENT_SECRET     — Access service-token secret.
 *                                  Together the two carry a
 *                                  `role=service` publisher
 *                                  identity through the API.
 *   R2_S3_ENDPOINT              — R2 S3-compatible endpoint.
 *   R2_ACCESS_KEY_ID            — R2 S3 access key id.
 *   R2_SECRET_ACCESS_KEY        — R2 S3 secret access key.
 *   CATALOG_R2_BUCKET           — optional; defaults to
 *                                  `terraviz-assets`.
 *
 * Flags:
 *
 *   --dataset-id=<ULID>         Required. The dataset to encode for.
 *   --source-key=<r2-key>       Required. Source MP4 key in R2.
 *                                Validated to start with
 *                                `uploads/` so the runner refuses
 *                                to encode against arbitrary keys.
 *   --source-digest=<sha256:..> Required. Verified against the
 *                                downloaded bytes before encoding.
 *   --workdir=<path>            Optional. Per-run workdir parent.
 *                                Defaults to
 *                                `/tmp/terraviz-transcode/{id}`.
 *   --cleanup-on-failure        Optional. Remove the workdir even
 *                                on failure.
 *   --ffmpeg-bin=<path>         Optional. ffmpeg binary override.
 *
 * Exit codes:
 *
 *   0 — success
 *   1 — argument / env validation error
 *   2 — source download / digest mismatch
 *   3 — encode failure (`encodeHls` threw)
 *   4 — upload failure (`uploadHlsBundle` threw)
 *   5 — transcode-complete PATCH failure (publisher API non-2xx)
 *
 * The exit code maps onto the workflow's job status so an operator
 * skimming the GitHub Actions UI sees which stage broke without
 * digging into the run log.
 */

import { createHash } from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { AwsClient } from 'aws4fetch'
import { encodeHls } from './lib/ffmpeg-hls'
import {
  uploadHlsBundle,
  loadR2ConfigFromEnv,
  type R2UploadConfig,
} from './lib/r2-upload'

const R2_REGION = 'auto'

/** Source-shape discriminator carried in the dispatch payload's
 *  `kind` field. The runner's pre-encode logic differs (single
 *  GET vs. N parallel GETs); the encode + upload + callback
 *  stages are identical. */
export type SourceKind = 'video' | 'frames'

export type Args =
  | {
      sourceKind: 'video'
      datasetId: string
      uploadId: string
      sourceKey: string
      sourceDigest: string
      workdir: string
      cleanupOnFailure: boolean
      ffmpegBin: string | null
    }
  | {
      sourceKind: 'frames'
      datasetId: string
      uploadId: string
      frameCount: number
      frameExtension: string
      sourceDigest: string
      workdir: string
      cleanupOnFailure: boolean
      ffmpegBin: string | null
    }

const FRAME_EXTENSION_ALLOWLIST = new Set(['png', 'jpg', 'webp'])

export function parseArgs(argv: readonly string[]): Args | { error: string } {
  const get = (name: string): string | null => {
    const prefix = `--${name}=`
    const match = argv.find(a => a.startsWith(prefix))
    return match ? match.slice(prefix.length) : null
  }
  const has = (name: string): boolean => argv.includes(`--${name}`)

  const datasetId = get('dataset-id')
  if (!datasetId || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(datasetId)) {
    return { error: `--dataset-id must be a ULID (26 base32 chars); got ${datasetId ?? '(missing)'}` }
  }
  const uploadId = get('upload-id')
  if (!uploadId || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(uploadId)) {
    return { error: `--upload-id must be a ULID (26 base32 chars); got ${uploadId ?? '(missing)'}` }
  }
  const sourceDigest = get('source-digest')
  if (!sourceDigest || !/^sha256:[0-9a-f]{64}$/.test(sourceDigest)) {
    return {
      error: `--source-digest must be sha256:<64-hex>; got ${sourceDigest ?? '(missing)'}`,
    }
  }
  const workdir = get('workdir') ?? `/tmp/terraviz-transcode/${datasetId}-${uploadId}`
  const cleanupOnFailure = has('cleanup-on-failure')
  const ffmpegBin = get('ffmpeg-bin')

  // Phase 3pf: a `--source-kind` flag selects between the
  // legacy MP4 source path (default) and the image-sequence
  // path. Default is `'video'` so the existing GHA workflow
  // keeps working unchanged for MP4 dispatches.
  const sourceKindRaw = get('source-kind') ?? 'video'
  if (sourceKindRaw !== 'video' && sourceKindRaw !== 'frames') {
    return {
      error: `--source-kind must be 'video' or 'frames'; got "${sourceKindRaw}"`,
    }
  }
  const sourceKind = sourceKindRaw as SourceKind

  if (sourceKind === 'video') {
    const sourceKey = get('source-key')
    // Match the full shape and pin the embedded ids to the route
    // arguments. The prior prefix/suffix-only check accepted
    // arbitrary middle segments (e.g. the obsolete one-level
    // `uploads/{dataset_id}/source.mp4`) and didn't notice when
    // a misrouted dispatch carried a key for a different dataset
    // or upload. PR #112 Copilot 3pd-followup.
    const expectedSourceKey = `uploads/${datasetId}/${uploadId}/source.mp4`
    if (!sourceKey || sourceKey !== expectedSourceKey) {
      return {
        error: `--source-key must equal ${expectedSourceKey}; got ${sourceKey ?? '(missing)'}`,
      }
    }
    return {
      sourceKind: 'video',
      datasetId,
      uploadId,
      sourceKey,
      sourceDigest,
      workdir,
      cleanupOnFailure,
      ffmpegBin,
    }
  }

  // sourceKind === 'frames'
  const frameCountRaw = get('frame-count')
  const frameCount = frameCountRaw !== null ? Number(frameCountRaw) : NaN
  if (!Number.isInteger(frameCount) || frameCount <= 0 || frameCount > 10_000) {
    return {
      error: `--frame-count must be a positive integer ≤ 10000; got ${frameCountRaw ?? '(missing)'}`,
    }
  }
  const frameExtension = get('frame-extension')
  if (!frameExtension || !FRAME_EXTENSION_ALLOWLIST.has(frameExtension)) {
    return {
      error: `--frame-extension must be one of ${[...FRAME_EXTENSION_ALLOWLIST].join(', ')}; got ${frameExtension ?? '(missing)'}`,
    }
  }
  return {
    sourceKind: 'frames',
    datasetId,
    uploadId,
    frameCount,
    frameExtension,
    sourceDigest,
    workdir,
    cleanupOnFailure,
    ffmpegBin,
  }
}

interface ServerEnv {
  server: string
  accessClientId: string
  accessClientSecret: string
}

export function loadServerEnv(env: NodeJS.ProcessEnv = process.env): ServerEnv | { error: string } {
  const missing: string[] = []
  if (!env.TERRAVIZ_SERVER) missing.push('TERRAVIZ_SERVER')
  if (!env.CF_ACCESS_CLIENT_ID) missing.push('CF_ACCESS_CLIENT_ID')
  if (!env.CF_ACCESS_CLIENT_SECRET) missing.push('CF_ACCESS_CLIENT_SECRET')
  if (missing.length) {
    return { error: `Missing env vars: ${missing.join(', ')}` }
  }
  return {
    server: env.TERRAVIZ_SERVER!.replace(/\/$/, ''),
    accessClientId: env.CF_ACCESS_CLIENT_ID!,
    accessClientSecret: env.CF_ACCESS_CLIENT_SECRET!,
  }
}

/**
 * Image-sequence source fetch. Downloads all N frames in parallel
 * (with a bounded concurrency so the runner's outbound socket
 * count stays reasonable on a 10 000-frame upper-bound), writing
 * each to `frames/{NNNNN}.{ext}` under the workdir. Per-frame
 * digest verification matches the digests the publisher's
 * client computed at upload time and embedded in the
 * source-filenames blob.
 *
 * Bounded-concurrency upper-bound is 16 — sufficient to keep the
 * R2 endpoint warm without consuming the runner's file-descriptor
 * budget at the cap. The MP4 path's single GET is the obvious
 * baseline; image sequences only need parallelism because there
 * are many objects, not because any single one is large.
 */
async function downloadFrames(
  config: R2UploadConfig,
  framesDir: string,
  args: { datasetId: string; uploadId: string; frameCount: number; frameExtension: string },
): Promise<void> {
  const CONCURRENCY = 16
  let cursor = 0
  let firstError: Error | null = null

  async function worker(): Promise<void> {
    while (firstError === null) {
      const i = cursor++
      if (i >= args.frameCount) return
      const padded = String(i).padStart(5, '0')
      const key = `uploads/${args.datasetId}/${args.uploadId}/frames/${padded}.${args.frameExtension}`
      const destPath = join(framesDir, `${padded}.${args.frameExtension}`)
      try {
        await downloadFromR2(config, key, destPath)
      } catch (err) {
        const wrapped = err instanceof Error ? err : new Error(String(err))
        // First-failure-wins so subsequent workers exit promptly.
        // The wrapped message embeds the offending key so the
        // operator's GHA log points directly at which frame
        // failed rather than a generic "R2 GET returned 404".
        if (firstError === null) {
          firstError = new Error(`Frame fetch failed at ${key}: ${wrapped.message}`)
        }
        return
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
  if (firstError) throw firstError
}

/**
 * Fetch the canonical source-filenames JSON blob alongside the
 * frames and recompute its SHA-256. Mismatch against
 * `--source-digest` (which the publisher API extracts from the
 * asset_uploads row's `claimed_digest`) fails the encode rather
 * than letting the runner work on a tampered manifest.
 *
 * The blob's contents aren't passed to ffmpeg — display naming is
 * derived server-side from the dataset's slug + start_time +
 * period (or slug + index for non-time-series rows) — but its
 * hash is the integrity gate the publisher API trusted at
 * /complete time. Re-verifying here is the same bargain the MP4
 * path makes with its source MP4's hash.
 */
async function verifySourceFilenamesBlob(
  config: R2UploadConfig,
  args: { datasetId: string; uploadId: string; sourceDigest: string; workdir: string },
): Promise<void> {
  const key = `uploads/${args.datasetId}/${args.uploadId}/source_filenames.json`
  const destPath = join(args.workdir, 'source_filenames.json')
  const result = await downloadFromR2(config, key, destPath)
  if (result.digest !== args.sourceDigest) {
    throw new Error(
      `source-filenames digest mismatch. expected=${args.sourceDigest} actual=${result.digest}`,
    )
  }
}

async function downloadFromR2(
  config: R2UploadConfig,
  key: string,
  destPath: string,
): Promise<{ digest: string; bytes: number }> {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: R2_REGION,
  })
  const encodedKey = key.split('/').map(s => encodeURIComponent(s)).join('/')
  const url = `${config.endpoint}/${encodeURIComponent(config.bucket)}/${encodedKey}`

  const res = await client.fetch(url, { method: 'GET' })
  if (!res.ok || !res.body) {
    throw new Error(`R2 GET ${key} returned ${res.status}: ${await res.text().catch(() => '')}`)
  }

  const hash = createHash('sha256')
  const sink = createWriteStream(destPath)
  let bytes = 0
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
      bytes += value.length
      if (!sink.write(value)) {
        await new Promise<void>(resolve => sink.once('drain', () => resolve()))
      }
    }
  } finally {
    sink.end()
    await new Promise<void>(resolve => sink.once('close', () => resolve()))
  }
  return { digest: `sha256:${hash.digest('hex')}`, bytes }
}

/**
 * Detect Cloudflare's WAF managed-challenge interstitial in a
 * response we got back from `transcode-complete`. Access service
 * tokens bypass Cloudflare Access but NOT Bot Fight Mode / WAF
 * managed rules — when the WAF challenges a runner request, the
 * response is a `Just a moment...` HTML page with a `_cf_chl_opt`
 * JS blob, served at the edge before the request ever reaches the
 * publisher Worker. Without this detection the failure dumps ~30
 * KB of obfuscated challenge HTML into the GHA log; with it the
 * operator sees a one-line pointer at the SELF_HOSTING WAF rule.
 */
export function isCloudflareChallenge(contentType: string | null, body: string): boolean {
  if (!contentType || !contentType.toLowerCase().includes('text/html')) return false
  // Both markers appear in every Cloudflare challenge variant
  // (managed / interactive / JS). The publisher API only ever
  // returns application/json, so any HTML body carrying either
  // marker is definitionally an edge intercept.
  return body.includes('_cf_chl_opt') || body.includes('challenge-platform')
}

export async function postTranscodeComplete(
  server: ServerEnv,
  datasetId: string,
  uploadId: string,
  sourceDigest: string,
): Promise<void> {
  const url = `${server.server}/api/v1/publish/datasets/${datasetId}/transcode-complete`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'CF-Access-Client-Id': server.accessClientId,
      'CF-Access-Client-Secret': server.accessClientSecret,
    },
    // The server constructs data_ref itself from the route id +
    // upload_id. We just identify which upload this transcode
    // finalises; the path convention is fixed
    // (`r2:videos/{datasetId}/{uploadId}/master.m3u8`) so neither
    // side has to negotiate it.
    body: JSON.stringify({ upload_id: uploadId, source_digest: sourceDigest }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    if (isCloudflareChallenge(res.headers.get('content-type'), body)) {
      let zone = 'unknown'
      try {
        zone = new URL(url).hostname
      } catch {
        /* keep the fallback */
      }
      throw new Error(
        `transcode-complete blocked by Cloudflare's WAF managed challenge ` +
          `(status ${res.status}, zone ${zone}). Access service tokens bypass ` +
          `Access but not Bot Fight Mode / WAF managed rules, so the request ` +
          `never reached the publisher Worker. Fix: add a WAF Skip custom rule ` +
          `for /api/v1/publish/* requests carrying the cf-access-client-id ` +
          `header — see docs/SELF_HOSTING.md §8e "WAF skip rule for the ` +
          `transcode-complete callback" for the exact rule.`,
      )
    }
    throw new Error(`transcode-complete returned ${res.status}: ${body}`)
  }

  // 2xx is necessary but not sufficient. A Pages deploy that
  // doesn't have the /transcode-complete route handler returns
  // the SPA's index.html with status 200 for any unmatched API
  // path — exactly what the CLI was trusting as success. Verify
  // the response is JSON with the row payload the route is
  // supposed to return; if it's HTML (or anything other shape),
  // the workflow is talking to the wrong deploy. PR #112
  // followup — caught after a smoke-test "transcoding cleared"
  // log lied because the workflow was hitting a main-branch
  // deploy that predated this PR's route handler.
  const contentType = res.headers.get('content-type') ?? ''
  const body = await res.text().catch(() => '')
  if (!contentType.toLowerCase().includes('application/json')) {
    let zone = 'unknown'
    try {
      zone = new URL(url).hostname
    } catch {
      /* keep the fallback */
    }
    const snippet = body.slice(0, 200).replace(/\s+/g, ' ').trim()
    throw new Error(
      `transcode-complete returned a 2xx response with non-JSON content-type ` +
        `"${contentType}" from ${zone}. The route handler did not run — most ` +
        `likely the Pages deploy at this hostname does not have the ` +
        `/transcode-complete function file yet (the deploy is on a branch ` +
        `that predates the publisher transcode pipeline). Check that ` +
        `TERRAVIZ_SERVER points at a deploy that includes the publisher API ` +
        `routes. Body preview: ${snippet}`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (err) {
    throw new Error(
      `transcode-complete returned 2xx with Content-Type ${contentType} but ` +
        `the body is not parseable JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  // The success response always carries a `dataset` field (either
  // the freshly-cleared row or, on idempotent retry, the
  // already-cleared row). Either shape proves the route ran.
  // `typeof null === 'object'` in JS so the null case needs an
  // explicit guard.
  const dataset =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { dataset?: unknown }).dataset
      : undefined
  if (typeof dataset !== 'object' || dataset === null) {
    throw new Error(
      `transcode-complete returned 2xx JSON but the body shape doesn't match ` +
        `the route's contract (expected { dataset: {...}, ... }). The deploy ` +
        `may be serving a different route handler. Body: ${body.slice(0, 200)}`,
    )
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const parsedArgs = parseArgs(argv)
  if ('error' in parsedArgs) {
    console.error(`error: ${parsedArgs.error}`)
    return 1
  }
  const args = parsedArgs

  const serverEnv = loadServerEnv()
  if ('error' in serverEnv) {
    console.error(`error: ${serverEnv.error}`)
    return 1
  }

  const r2Config = loadR2ConfigFromEnv()
  if (!r2Config.endpoint || !r2Config.accessKeyId || !r2Config.secretAccessKey) {
    console.error(
      'error: R2 config is incomplete. Set R2_S3_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.',
    )
    return 1
  }

  // Prepare the workdir.
  if (existsSync(args.workdir)) {
    rmSync(args.workdir, { recursive: true, force: true })
  }
  mkdirSync(args.workdir, { recursive: true })
  const outputDir = join(args.workdir, 'hls')
  mkdirSync(outputDir, { recursive: true })

  let exitCode = 0
  let ffmpegInputPath: string
  let ffmpegInputArgs: readonly string[] = []
  try {
    if (args.sourceKind === 'video') {
      // MP4 source — single GET, single digest verify.
      const sourcePath = join(args.workdir, 'source.mp4')
      console.error(`[transcode] downloading source from r2://${args.sourceKey}`)
      const downloaded = await downloadFromR2(r2Config, args.sourceKey, sourcePath)
      console.error(`[transcode] downloaded ${downloaded.bytes} bytes (${downloaded.digest})`)
      if (downloaded.digest !== args.sourceDigest) {
        console.error(
          `error: source digest mismatch. expected=${args.sourceDigest} actual=${downloaded.digest}`,
        )
        exitCode = 2
        return exitCode
      }
      ffmpegInputPath = sourcePath
      // No `inputArgs` for MP4 — ffmpeg reads encoded fps from the
      // source itself. The `-r 30` on each output rendition in
      // `buildFfmpegArgs` then normalises every encode to 30 fps.
    } else {
      // Image-sequence source — N parallel GETs of
      // `uploads/{ds}/{up}/frames/{NNNNN}.{ext}` + one GET of the
      // canonical source-filenames JSON blob whose hash we verify
      // against `--source-digest` before encoding.
      const framesDir = join(args.workdir, 'frames')
      mkdirSync(framesDir, { recursive: true })
      try {
        await downloadFrames(r2Config, framesDir, args)
        await verifySourceFilenamesBlob(r2Config, args)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`error: ${message}`)
        // Exit code 6 — distinct from `2` (MP4 source) so an
        // operator skimming the workflow run can tell which path
        // failed without digging into the log.
        exitCode = 6
        return exitCode
      }
      // ffmpeg's image-sequence demuxer reads `framesDir/%05d.png`
      // (or .jpg / .webp) and treats each numbered frame as one
      // input frame at the declared `-framerate`. The `-r 30` on
      // each output rendition then keeps the encode at the
      // catalog-wide 30 fps invariant.
      ffmpegInputPath = join(framesDir, `%05d.${args.frameExtension}`)
      ffmpegInputArgs = ['-framerate', '30']
    }

    console.error(`[transcode] encoding ${ffmpegInputPath} → ${outputDir}`)
    const encodeStart = Date.now()
    const encoded = await encodeHls({
      inputPath: ffmpegInputPath,
      outputDir,
      ffmpegBin: args.ffmpegBin ?? undefined,
      onProgress: line => process.stderr.write(`[ffmpeg] ${line}\n`),
      inputArgs: ffmpegInputArgs,
      // Image sequences are silent — skip the audio probe (which
      // would fail against the image-sequence pattern anyway) and
      // tell `buildFfmpegArgs` to omit the audio mapping. MP4
      // sources keep the auto-detect default.
      hasAudio: args.sourceKind === 'frames' ? false : undefined,
    })
    console.error(
      `[transcode] encode done in ${Date.now() - encodeStart} ms; ${encoded.files.length} files`,
    )

    // 4. Upload bundle to a per-upload-id prefix. Scoping by
    //    upload_id means a re-upload to an already-published row
    //    lands in a fresh prefix without overwriting the bundle
    //    the public manifest is still serving — the
    //    `/transcode-complete` route swaps `data_ref` atomically
    //    when this script finishes. Fix for PR #112 Copilot #15.
    const bundlePrefix = `videos/${args.datasetId}/${args.uploadId}`
    console.error(`[transcode] uploading bundle → r2://${bundlePrefix}/`)
    const uploadStart = Date.now()
    const uploaded = await uploadHlsBundle(r2Config, outputDir, bundlePrefix, {
      onProgress: info =>
        console.error(`[r2] PUT ${info.key} (${info.bytes} B; ${info.done}/${info.total})`),
    })
    console.error(
      `[transcode] upload done in ${Date.now() - uploadStart} ms; ${uploaded.totalBytes} bytes total`,
    )

    // 5. POST transcode-complete. The server constructs the
    //    expected data_ref from (route id + upload id) and
    //    refuses any mismatch — we don't pass it.
    console.error(
      `[transcode] POST transcode-complete dataset=${args.datasetId} upload=${args.uploadId}`,
    )
    await postTranscodeComplete(serverEnv, args.datasetId, args.uploadId, args.sourceDigest)
    console.error('[transcode] done — row updated, transcoding cleared')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`error: ${message}`)
    // Map error type to exit code; default to 5 (PATCH) since that's
    // the trailing step and the most ambiguous failure point.
    if (message.includes('R2 GET') || message.includes('digest mismatch')) exitCode = 2
    else if (message.includes('FfmpegError') || message.toLowerCase().includes('ffmpeg')) exitCode = 3
    else if (message.includes('uploadHlsBundle') || message.includes('R2UploadError')) exitCode = 4
    else if (message.includes('transcode-complete')) exitCode = 5
    else exitCode = 3
  } finally {
    if (exitCode === 0 || args.cleanupOnFailure) {
      try {
        rmSync(args.workdir, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    } else {
      console.error(`[transcode] keeping workdir at ${args.workdir} for post-mortem`)
    }
  }
  return exitCode
}

// Only run when invoked directly (e.g. `tsx cli/transcode-from-dispatch.ts`
// from the GHA workflow). Tests import named helpers and shouldn't
// trigger the side-effecting pipeline at module load.
const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url === `file://${process.argv[1]}`
if (invokedDirectly) {
  void main().then(code => process.exit(code))
}
