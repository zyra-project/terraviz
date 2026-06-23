/**
 * Tests for `cli/lib/frames-publish.ts` — publishing a runner's
 * padded frame directory as an image-sequence asset
 * (`docs/ZYRA_INTEGRATION_PLAN.md` §Real-time frame store, stage 3).
 *
 * Coverage:
 *   - `hashFramesDir`: sorts + hashes frames, derives a uniform
 *     mime, rejects empty dirs and mixed extensions.
 *   - `buildSourceFilenames`: the `[{index,filename,digest}]`
 *     manifest + its SHA-256 (the byte-exact contract the transcode
 *     re-verifies).
 *   - `publishFrameSequence`: drives a stubbed TerravizClient
 *     through init → per-frame PUT → manifest PUT → complete, and
 *     honours the mock-mode skip.
 */

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSourceFilenames,
  hashFramesDir,
  publishFrameSequence,
  type FrameDigest,
} from './frames-publish'
import type { TerravizClient } from './client'

function tmpFrames(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'fpub-'))
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content)
  }
  return dir
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

describe('hashFramesDir', () => {
  it('hashes frames in sorted order with a uniform mime', async () => {
    const dir = tmpFrames({
      'f_20240108.png': 'b',
      'f_20240101.png': 'a',
    })
    const result = await hashFramesDir(dir)
    expect(result.mime).toBe('image/png')
    expect(result.totalSize).toBe(2)
    expect(result.frames.map(f => f.filename)).toEqual(['f_20240101.png', 'f_20240108.png'])
    expect(result.frames[0].digest).toBe(`sha256:${sha256Hex('a')}`)
  })

  it('maps jpg/jpeg to image/jpeg', async () => {
    const result = await hashFramesDir(tmpFrames({ 'a.jpg': 'x', 'b.jpeg': 'y' }))
    expect(result.mime).toBe('image/jpeg')
  })

  it('throws on an empty directory', async () => {
    await expect(hashFramesDir(tmpFrames({}))).rejects.toThrow(/no frames/)
  })

  it('throws on mixed frame mime types', async () => {
    await expect(hashFramesDir(tmpFrames({ 'a.png': 'x', 'b.jpg': 'y' }))).rejects.toThrow(/mixed/)
  })
})

describe('buildSourceFilenames', () => {
  it('builds the canonical [{index,filename,digest}] manifest + digest', () => {
    const frames: FrameDigest[] = [
      { filename: 'a.png', digest: 'sha256:aa', size: 1 },
      { filename: 'b.png', digest: 'sha256:bb', size: 1 },
    ]
    const { json, digest } = buildSourceFilenames(frames)
    expect(JSON.parse(json)).toEqual([
      { index: 0, filename: 'a.png', digest: 'sha256:aa' },
      { index: 1, filename: 'b.png', digest: 'sha256:bb' },
    ])
    // The digest is the SHA-256 of the exact bytes — the contract
    // the transcode runner re-verifies.
    expect(digest).toBe(`sha256:${sha256Hex(json)}`)
  })
})

/** Minimal stub of the TerravizClient surface publishFrameSequence
 *  touches, recording calls for assertions. */
function makeStubClient(
  opts: { mock?: boolean; onUpload?: (url: string) => { ok: boolean; status: number; message?: string } } = {},
) {
  const calls = {
    init: [] as unknown[],
    putUrls: [] as string[],
    complete: [] as Array<[string, string]>,
  }
  const client = {
    initImageSequenceUpload: (_datasetId: string, body: unknown) => {
      calls.init.push(body)
      const frames = (body as { frames: FrameDigest[] }).frames
      return Promise.resolve({
        ok: true,
        status: 201,
        body: {
          upload_id: 'UPLOAD01',
          kind: 'data',
          target: 'r2',
          frames: frames.map((f, index) => ({
            filename: f.filename,
            index,
            method: 'PUT',
            url: `https://r2.example/frames/${index}`,
            headers: {},
            key: `uploads/d/u/frames/${String(index).padStart(5, '0')}.png`,
          })),
          source_filenames: {
            method: 'PUT',
            url: 'https://r2.example/source_filenames.json',
            headers: {},
            key: 'uploads/d/u/source_filenames.json',
          },
          expires_at: '2030-01-01T00:00:00Z',
          mock: opts.mock ?? false,
        },
      })
    },
    uploadBytes: (_target: string, url: string) => {
      calls.putUrls.push(url)
      return Promise.resolve(opts.onUpload?.(url) ?? { ok: true, status: 200 })
    },
    completeAssetUpload: (datasetId: string, uploadId: string) => {
      calls.complete.push([datasetId, uploadId])
      return Promise.resolve({ ok: true, status: 200, body: {} })
    },
  } as unknown as TerravizClient
  return { client, calls }
}

describe('publishFrameSequence', () => {
  it('inits, PUTs every frame + the manifest, then completes', async () => {
    const dir = tmpFrames({ 'f_1.png': 'a', 'f_2.png': 'b', 'f_3.png': 'c' })
    const { client, calls } = makeStubClient()
    const result = await publishFrameSequence(client, 'DATASET01', dir, { concurrency: 1 })

    expect(result).toEqual({ uploadId: 'UPLOAD01', frameCount: 3, mock: false })
    // 3 frame PUTs + 1 manifest PUT.
    expect(calls.putUrls).toHaveLength(4)
    expect(calls.putUrls).toContain('https://r2.example/source_filenames.json')
    expect(calls.complete).toEqual([['DATASET01', 'UPLOAD01']])
    // The init body carried the frames with digests + the manifest digest.
    const initBody = calls.init[0] as { frames: FrameDigest[]; source_filenames_digest: string }
    expect(initBody.frames.map(f => f.filename)).toEqual(['f_1.png', 'f_2.png', 'f_3.png'])
    expect(initBody.source_filenames_digest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('skips the byte PUTs in mock mode but still completes', async () => {
    const dir = tmpFrames({ 'f_1.png': 'a' })
    const { client, calls } = makeStubClient({ mock: true })
    const result = await publishFrameSequence(client, 'DATASET01', dir)

    expect(result.mock).toBe(true)
    expect(calls.putUrls).toHaveLength(0)
    expect(calls.complete).toEqual([['DATASET01', 'UPLOAD01']])
  })

  it('retries a transient 500 PUT and succeeds (R2 InternalError)', async () => {
    const dir = tmpFrames({ 'f_1.png': 'a' })
    const failedOnce = new Set<string>()
    const { client, calls } = makeStubClient({
      onUpload: url => {
        if (!failedOnce.has(url)) {
          failedOnce.add(url)
          return { ok: false, status: 500, message: 'InternalError' }
        }
        return { ok: true, status: 200 }
      },
    })
    const result = await publishFrameSequence(client, 'DATASET01', dir, { concurrency: 1, retryDelayMs: 0 })
    expect(result.frameCount).toBe(1)
    // frame PUT (1 fail + 1 ok) + manifest PUT (1 fail + 1 ok) = 4 calls.
    expect(calls.putUrls).toHaveLength(4)
  })

  it('gives up after putAttempts on a persistent 5xx and reports the attempt count', async () => {
    const dir = tmpFrames({ 'f_1.png': 'a' })
    const { client } = makeStubClient({ onUpload: () => ({ ok: false, status: 503, message: 'unavailable' }) })
    await expect(
      publishFrameSequence(client, 'DATASET01', dir, { concurrency: 1, putAttempts: 3, retryDelayMs: 0 }),
    ).rejects.toThrow(/after 3 attempt\(s\)/)
  })

  it('does not retry a deterministic 4xx', async () => {
    const dir = tmpFrames({ 'f_1.png': 'a' })
    const { client, calls } = makeStubClient({ onUpload: () => ({ ok: false, status: 403, message: 'forbidden' }) })
    await expect(
      publishFrameSequence(client, 'DATASET01', dir, { concurrency: 1, putAttempts: 4, retryDelayMs: 0 }),
    ).rejects.toThrow(/\(403\).*after 1 attempt/)
    expect(calls.putUrls).toHaveLength(1) // one attempt, no retry
  })

  it('clamps a stray putAttempts: 0 up to a single attempt', async () => {
    const dir = tmpFrames({ 'f_1.png': 'a' })
    const { client, calls } = makeStubClient({ onUpload: () => ({ ok: false, status: 500, message: 'x' }) })
    await expect(
      publishFrameSequence(client, 'DATASET01', dir, { concurrency: 1, putAttempts: 0, retryDelayMs: 0 }),
    ).rejects.toThrow(/after 1 attempt/)
    expect(calls.putUrls).toHaveLength(1) // clamped to 1, not 0
  })
})
