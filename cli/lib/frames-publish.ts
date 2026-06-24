/**
 * Publish a directory of frames as an image-sequence asset
 * (`docs/ZYRA_INTEGRATION_PLAN.md` §Real-time frame store, stage 3 —
 * frame recall).
 *
 * When a real-time workflow drops `compose-video` and leaves its
 * padded, cadence-complete frames on disk, the runner publishes
 * them through the *existing* image-sequence asset path instead of
 * an MP4. That one path does double duty: the transcode builds the
 * playable HLS bundle **and** sets the row's frame columns, lighting
 * up `/api/v1/datasets/{id}/frames` for individual download — so
 * recall is reuse, not a new surface.
 *
 * This module is the Node-side equivalent of the portal's
 * `asset-uploader.ts` frames flow: hash each frame, build the
 * `source_filenames.json` manifest + its digest, init the upload,
 * PUT every frame + the manifest, and complete (which fires the
 * transcode). The manifest shape — `[{ index, filename, digest }]`,
 * `JSON.stringify`'d then SHA-256'd — matches byte-for-byte what
 * `cli/transcode-from-dispatch.ts` re-verifies and what
 * `functions/api/v1/_lib/frames-manifest.ts` parses.
 */

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Result, TerravizClient } from './client'

/** Frame extensions we publish, mapped to the image-sequence mime
 *  allow-list the API enforces. */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

const FRAME_EXT_RE = /\.(png|jpe?g|webp)$/i

/** Bounded parallelism for the per-frame PUTs — matches the HLS
 *  bundle uploader's default (`r2-upload.ts`). */
const DEFAULT_CONCURRENCY = 6

/** One entry in the `frames` array the init body carries. */
export interface FrameDigest {
  filename: string
  digest: string
  size: number
}

export interface HashedFrames {
  frames: FrameDigest[]
  /** The single mime every frame shares (sequence uploads reject a
   *  mixed set). */
  mime: string
  totalSize: number
}

/** Wire shape of `ImageSequenceInitResponse` (subset the runner
 *  needs). Defined here so the CLI doesn't import a Pages-Function
 *  type. */
interface InitFrame {
  filename: string
  index: number
  method: 'PUT'
  url: string
  headers: Record<string, string>
  key: string
}
interface ImageSequenceInitResponse {
  upload_id: string
  kind: 'data'
  target: 'r2'
  frames: InitFrame[]
  source_filenames: { method: 'PUT'; url: string; headers: Record<string, string>; key: string }
  expires_at: string
  mock: boolean
}

export interface FramesPublishResult {
  uploadId: string
  frameCount: number
  /** Frames actually PUT this run (new content). */
  uploaded: number
  /** Frames skipped because their content-addressed object already
   *  existed in R2 (the dedupe win). */
  reused: number
  /** This run's frame digests (`sha256:<hex>`), in encode order — the
   *  current side of the GC keep-set. */
  digests: string[]
  mock: boolean
}

export interface FramesPublishOptions {
  log?: (line: string) => void
  /** Override the per-frame PUT concurrency (tests pin it to 1). */
  concurrency?: number
  /** Total attempts per R2 PUT before giving up. R2 returns sporadic
   *  500 InternalError, so a single un-retried PUT among thousands of
   *  frames fails the whole publish. Default 4. */
  putAttempts?: number
  /** Base backoff between PUT retries (ms); doubles each attempt.
   *  Default 500. Tests pass 0. */
  retryDelayMs?: number
  /**
   * Optional content-addressed HEAD gate
   * (`docs/INCREMENTAL_FRAME_UPLOAD_PLAN.md`). When supplied, each
   * frame's presigned PUT is skipped if its (content-addressed) R2 key
   * already exists — so a scheduled re-publish only uploads the frames
   * whose bytes changed. Backed by an R2 S3 HEAD on the runner; absent
   * (e.g. the browser portal, which can't read R2) every frame is
   * uploaded, which is correct, just not deduped.
   */
  exists?: (key: string) => Promise<boolean>
}

const DEFAULT_PUT_ATTEMPTS = 4
const DEFAULT_RETRY_DELAY_MS = 500

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve()
}

/**
 * PUT bytes to a presigned R2 URL, retrying transient failures — a
 * network blip (`status 0`), a 429, or any 5xx. R2 hands back
 * occasional `500 InternalError`, and with thousands of frame PUTs the
 * odds of hitting one are high; a single un-retried failure would sink
 * the whole publish. Deterministic 4xx (except 429) fails fast.
 * Backoff doubles each attempt from `delayMs`.
 */
async function putBytesWithRetry(
  client: TerravizClient,
  url: string,
  headers: Record<string, string>,
  bytes: Uint8Array,
  mime: string,
  filename: string,
  attempts: number,
  delayMs: number,
): Promise<{ ok: boolean; status: number; message?: string; attempts: number }> {
  let last: { ok: boolean; status: number; message?: string } = { ok: false, status: 0 }
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await client.uploadBytes('r2', url, headers, bytes, mime, filename)
    if (last.ok) return { ...last, attempts: attempt }
    const retriable = last.status === 0 || last.status === 429 || last.status >= 500
    if (!retriable || attempt === attempts) return { ...last, attempts: attempt }
    await sleep(delayMs * 2 ** (attempt - 1))
  }
  return { ...last, attempts }
}

function mimeForName(name: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()
  return ext ? MIME_BY_EXT[ext] ?? null : null
}

/**
 * Read every frame in `framesDir` (sorted by name — the date-
 * stamped, zero-padded scheduler names sort into encode order),
 * SHA-256 each, and assert a single uniform mime. Throws when the
 * directory has no frames or mixes extensions.
 */
export async function hashFramesDir(framesDir: string): Promise<HashedFrames> {
  const names = (await readdir(framesDir)).filter(n => FRAME_EXT_RE.test(n)).sort()
  if (names.length === 0) {
    throw new Error(`frames-publish: no frames found in ${framesDir}`)
  }
  let mime: string | null = null
  let totalSize = 0
  const frames: FrameDigest[] = []
  for (const name of names) {
    const m = mimeForName(name)
    if (!m) throw new Error(`frames-publish: unsupported frame extension: ${name}`)
    if (mime === null) mime = m
    else if (mime !== m) {
      throw new Error(`frames-publish: mixed frame mime types (${mime} vs ${m} for ${name})`)
    }
    const bytes = await readFile(join(framesDir, name))
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    frames.push({ filename: name, digest, size: bytes.byteLength })
    totalSize += bytes.byteLength
  }
  return { frames, mime: mime as string, totalSize }
}

/**
 * Build the canonical `source_filenames.json` manifest + its
 * SHA-256. Key order (`index`, then `filename`, then `digest`) and
 * `JSON.stringify`'s compact form are load-bearing: the runner
 * re-hashes the exact bytes returned here against the digest, so
 * this serialization is the contract.
 */
export function buildSourceFilenames(frames: FrameDigest[]): { json: string; digest: string } {
  const manifest = frames.map((f, index) => ({
    index,
    filename: f.filename,
    digest: f.digest,
  }))
  const json = JSON.stringify(manifest)
  const digest = `sha256:${createHash('sha256').update(json).digest('hex')}`
  return { json, digest }
}

/** PUT every frame to its presigned URL with bounded concurrency,
 *  re-reading each file by the filename the init response echoes
 *  back. Throws on the first failed PUT. */
async function putFrames(
  client: TerravizClient,
  framesDir: string,
  mime: string,
  initFrames: InitFrame[],
  concurrency: number,
  attempts: number,
  delayMs: number,
  exists?: (key: string) => Promise<boolean>,
): Promise<{ uploaded: number; reused: number }> {
  let cursor = 0
  let uploaded = 0
  let reused = 0
  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++
      if (i >= initFrames.length) return
      const fr = initFrames[i]
      // Content-addressed dedupe: skip the PUT when the frame's shared
      // object is already in R2. A best-effort HEAD failure falls
      // through to the PUT (re-uploading is always safe — the key is
      // idempotent), so a flaky HEAD never blocks the publish.
      if (exists) {
        let present = false
        try {
          present = await exists(fr.key)
        } catch {
          present = false
        }
        if (present) {
          reused++
          continue
        }
      }
      const bytes = new Uint8Array(await readFile(join(framesDir, fr.filename)))
      const put = await putBytesWithRetry(client, fr.url, fr.headers, bytes, mime, fr.filename, attempts, delayMs)
      if (!put.ok) {
        throw new Error(
          `frames-publish: frame PUT ${fr.filename} failed (${put.status})` +
            `${put.message ? `: ${put.message}` : ''} after ${put.attempts} attempt(s)`,
        )
      }
      uploaded++
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, initFrames.length)) }, () => worker()),
  )
  return { uploaded, reused }
}

/**
 * Publish `framesDir` as an image-sequence asset on `datasetId`:
 * hash → init → PUT frames + manifest → complete. Returns the
 * upload id so the caller can wait for the transcode to flip
 * `data_ref` (the wait + status callback stay with the runner, as
 * they do for the MP4 path). Throws on any API/upload failure.
 */
export async function publishFrameSequence(
  client: TerravizClient,
  datasetId: string,
  framesDir: string,
  options: FramesPublishOptions = {},
): Promise<FramesPublishResult> {
  const log = options.log ?? (() => {})
  const { frames, mime, totalSize } = await hashFramesDir(framesDir)
  const { json: manifestJson, digest: sourceFilenamesDigest } = buildSourceFilenames(frames)
  log(`frames-publish: ${frames.length} ${mime} frame(s), ${totalSize} bytes total`)

  const init = (await client.initImageSequenceUpload(datasetId, {
    kind: 'data',
    mime,
    size: totalSize,
    frames,
    source_filenames_digest: sourceFilenamesDigest,
  })) as Result<ImageSequenceInitResponse>
  if (!init.ok) {
    const detail = init.errors?.map(e => `${e.field}:${e.code}`).join(', ')
    throw new Error(`frames-publish: asset init failed (${init.status}) ${init.error}${detail ? ` [${detail}]` : ''}`)
  }
  const body = init.body

  // Clamp to sane values so a stray option (0, negative, float) can't
  // produce zero/odd attempts and silently weaken the upload.
  const attempts = Math.max(1, Math.floor(options.putAttempts ?? DEFAULT_PUT_ATTEMPTS))
  const delayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)

  let uploaded = 0
  let reused = 0
  if (body.mock) {
    log(`frames-publish: mock mode — skipping ${frames.length} frame PUTs + manifest`)
  } else {
    ;({ uploaded, reused } = await putFrames(
      client,
      framesDir,
      mime,
      body.frames,
      options.concurrency ?? DEFAULT_CONCURRENCY,
      attempts,
      delayMs,
      options.exists,
    ))
    // The source-filenames manifest is per-upload (it pins this run's
    // index→digest order), so it's always PUT, never deduped.
    const blob = new TextEncoder().encode(manifestJson)
    const blobPut = await putBytesWithRetry(
      client,
      body.source_filenames.url,
      body.source_filenames.headers,
      blob,
      'application/json',
      'source_filenames.json',
      attempts,
      delayMs,
    )
    if (!blobPut.ok) {
      throw new Error(
        `frames-publish: source-filenames PUT failed (${blobPut.status})` +
          `${blobPut.message ? `: ${blobPut.message}` : ''} after ${blobPut.attempts} attempt(s)`,
      )
    }
    log(
      `frames-publish: ${uploaded} frame(s) uploaded, ${reused} reused` +
        `${reused > 0 ? ` (content-addressed dedupe)` : ''} + manifest`,
    )
  }

  const complete = await client.completeAssetUpload<{ upload_id?: string }>(datasetId, body.upload_id)
  if (!complete.ok) {
    throw new Error(`frames-publish: complete failed (${complete.status}) ${complete.error}`)
  }
  return {
    uploadId: body.upload_id,
    frameCount: frames.length,
    uploaded,
    reused,
    digests: frames.map(f => f.digest),
    mock: body.mock,
  }
}
