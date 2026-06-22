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
  mock: boolean
}

export interface FramesPublishOptions {
  log?: (line: string) => void
  /** Override the per-frame PUT concurrency (tests pin it to 1). */
  concurrency?: number
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
): Promise<void> {
  let cursor = 0
  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++
      if (i >= initFrames.length) return
      const fr = initFrames[i]
      const bytes = new Uint8Array(await readFile(join(framesDir, fr.filename)))
      const put = await client.uploadBytes('r2', fr.url, fr.headers, bytes, mime, fr.filename)
      if (!put.ok) {
        throw new Error(`frames-publish: frame PUT ${fr.filename} failed (${put.status})${put.message ? `: ${put.message}` : ''}`)
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, initFrames.length)) }, () => worker()),
  )
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

  if (body.mock) {
    log(`frames-publish: mock mode — skipping ${frames.length} frame PUTs + manifest`)
  } else {
    await putFrames(client, framesDir, mime, body.frames, options.concurrency ?? DEFAULT_CONCURRENCY)
    const blob = new TextEncoder().encode(manifestJson)
    const blobPut = await client.uploadBytes(
      'r2',
      body.source_filenames.url,
      body.source_filenames.headers,
      blob,
      'application/json',
      'source_filenames.json',
    )
    if (!blobPut.ok) {
      throw new Error(`frames-publish: source-filenames PUT failed (${blobPut.status})${blobPut.message ? `: ${blobPut.message}` : ''}`)
    }
    log(`frames-publish: uploaded ${body.frames.length} frame(s) + manifest`)
  }

  const complete = await client.completeAssetUpload<{ upload_id?: string }>(datasetId, body.upload_id)
  if (!complete.ok) {
    throw new Error(`frames-publish: complete failed (${complete.status}) ${complete.error}`)
  }
  return { uploadId: body.upload_id, frameCount: frames.length, mock: body.mock }
}
