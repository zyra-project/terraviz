/**
 * Tests for `cli/lib/r2-frames.ts` — the R2-backed frame cache for
 * real-time Zyra workflow runs (`docs/ZYRA_INTEGRATION_PLAN.md`
 * §Real-time frame store, stage 1).
 *
 * Coverage:
 *   - Pure helpers: `buildWorkflowFramesPrefix` (ULID guard),
 *     `windowFrameBudget`, `isoDurationToSeconds`.
 *   - `restoreFramesFromR2`: downloads missing frames, skips ones
 *     already on disk, ignores non-frame keys, follows ListObjectsV2
 *     continuation tokens.
 *   - `saveFramesToR2`: uploads only frames not already cached,
 *     prunes the cache to the active window, prunes objects whose
 *     local frame is gone, and leaves everything when no window is
 *     given.
 *
 * R2 is faked in-memory: a `fetchImpl` that answers the S3
 * ListObjectsV2 / GET / PUT / DELETE shapes `r2-upload.ts`'s
 * `AwsClient` produces. Real round-trips are out of scope.
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildWorkflowFramesPrefix,
  isoDurationToSeconds,
  restoreFramesFromR2,
  saveFramesToR2,
  windowFrameBudget,
  WORKFLOW_FRAMES_PREFIX,
} from './r2-frames'
import type { R2UploadConfig } from './r2-upload'

const CONFIG: R2UploadConfig = {
  endpoint: 'https://acct123.r2.cloudflarestorage.com',
  accessKeyId: 'AKIATEST',
  secretAccessKey: 'secret-key',
  bucket: 'terraviz-assets',
}

// A valid Crockford ULID (26 chars, no I/L/O/U).
const DATASET = '0123456789ABCDEFGHJKMNPQRS'
const PREFIX = `${WORKFLOW_FRAMES_PREFIX}/${DATASET}/`

/** In-memory R2: a fetch impl + the backing store, so a test can
 *  assert what landed / was pruned. */
function makeFakeR2(initial: Record<string, Uint8Array> = {}) {
  const store = new Map<string, Uint8Array>(Object.entries(initial))
  const bucketPrefix = `/${CONFIG.bucket}/`

  const fetchImpl = (async (input: Request): Promise<Response> => {
    const url = new URL(input.url)
    if (url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? ''
      const keys = [...store.keys()].filter(k => k.startsWith(prefix)).sort()
      return new Response(listXml(keys), { status: 200 })
    }
    const key = url.pathname.startsWith(bucketPrefix)
      ? url.pathname.slice(bucketPrefix.length).split('/').map(decodeURIComponent).join('/')
      : ''
    if (input.method === 'PUT') {
      store.set(key, new Uint8Array(await input.arrayBuffer()))
      return new Response('', { status: 200 })
    }
    if (input.method === 'DELETE') {
      store.delete(key)
      return new Response('', { status: 204 })
    }
    const val = store.get(key)
    return val ? new Response(toBody(val), { status: 200 }) : new Response('missing', { status: 404 })
  }) as unknown as typeof fetch

  return { store, fetchImpl }
}

/** Uint8Array → ArrayBuffer (a valid Response BodyInit). */
function toBody(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer
}

function listXml(keys: string[], opts: { truncatedToken?: string } = {}): string {
  const contents = keys.map(k => `<Contents><Key>${k}</Key></Contents>`).join('')
  const trunc = opts.truncatedToken
    ? `<IsTruncated>true</IsTruncated><NextContinuationToken>${opts.truncatedToken}</NextContinuationToken>`
    : `<IsTruncated>false</IsTruncated>`
  return `<?xml version="1.0"?><ListBucketResult>${contents}${trunc}</ListBucketResult>`
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function tmpFramesDir(): string {
  return mkdtempSync(join(tmpdir(), 'r2frames-'))
}

describe('buildWorkflowFramesPrefix', () => {
  it('keys the cache by dataset ULID with a trailing slash', () => {
    expect(buildWorkflowFramesPrefix(DATASET)).toBe(`workflow-frames/${DATASET}/`)
  })
  it('rejects a non-ULID dataset id', () => {
    expect(() => buildWorkflowFramesPrefix('not-a-ulid')).toThrow(/ULID/)
  })
})

describe('windowFrameBudget', () => {
  it('counts cadence steps in the window, inclusive of both ends', () => {
    // One year of weekly frames: 365d / 7d ≈ 53 steps → 54 frames.
    expect(windowFrameBudget(365 * 86400, 604800)).toBe(54)
  })
  it('returns null (keep everything) when inputs are missing or non-positive', () => {
    expect(windowFrameBudget(null, 604800)).toBeNull()
    expect(windowFrameBudget(365 * 86400, null)).toBeNull()
    expect(windowFrameBudget(0, 604800)).toBeNull()
    expect(windowFrameBudget(365 * 86400, 0)).toBeNull()
  })
})

describe('isoDurationToSeconds', () => {
  it('parses common workflow durations', () => {
    expect(isoDurationToSeconds('P1Y')).toBe(365 * 86400)
    expect(isoDurationToSeconds('P1W')).toBe(7 * 86400)
    expect(isoDurationToSeconds('P30D')).toBe(30 * 86400)
    expect(isoDurationToSeconds('PT1H')).toBe(3600)
    expect(isoDurationToSeconds('P1DT12H')).toBe(86400 + 12 * 3600)
  })
  it('returns null for an unparseable or empty duration', () => {
    expect(isoDurationToSeconds('1Y')).toBeNull()
    expect(isoDurationToSeconds('P')).toBeNull()
    expect(isoDurationToSeconds('PT')).toBeNull()
    expect(isoDurationToSeconds('hello')).toBeNull()
  })
})

describe('restoreFramesFromR2', () => {
  it('downloads cached frames that are not already on disk', async () => {
    const { fetchImpl } = makeFakeR2({
      [`${PREFIX}f_20240101.png`]: bytes('a'),
      [`${PREFIX}f_20240108.png`]: bytes('b'),
    })
    const dir = tmpFramesDir()
    const result = await restoreFramesFromR2(CONFIG, DATASET, dir, { fetchImpl })
    expect(result).toEqual({ restored: 2, skipped: 0 })
    expect(readdirSync(dir).sort()).toEqual(['f_20240101.png', 'f_20240108.png'])
    expect(readFileSync(join(dir, 'f_20240101.png'), 'utf-8')).toBe('a')
  })

  it('skips frames already present locally', async () => {
    const { fetchImpl } = makeFakeR2({
      [`${PREFIX}f_20240101.png`]: bytes('remote'),
      [`${PREFIX}f_20240108.png`]: bytes('b'),
    })
    const dir = tmpFramesDir()
    writeFileSync(join(dir, 'f_20240101.png'), 'local')
    const result = await restoreFramesFromR2(CONFIG, DATASET, dir, { fetchImpl })
    expect(result).toEqual({ restored: 1, skipped: 1 })
    // The local copy is left untouched — not overwritten by the cache.
    expect(readFileSync(join(dir, 'f_20240101.png'), 'utf-8')).toBe('local')
  })

  it('ignores non-frame and nested keys under the prefix', async () => {
    const { fetchImpl } = makeFakeR2({
      [`${PREFIX}f_20240101.png`]: bytes('a'),
      [`${PREFIX}metadata/report.json`]: bytes('{}'),
      [`${PREFIX}notes.txt`]: bytes('x'),
    })
    const dir = tmpFramesDir()
    const result = await restoreFramesFromR2(CONFIG, DATASET, dir, { fetchImpl })
    expect(result).toEqual({ restored: 1, skipped: 0 })
    expect(readdirSync(dir)).toEqual(['f_20240101.png'])
  })

  it('follows ListObjectsV2 continuation tokens', async () => {
    const page1 = listXml([`${PREFIX}f_1.png`], { truncatedToken: 'TOKEN2' })
    const page2 = listXml([`${PREFIX}f_2.png`])
    const objects: Record<string, Uint8Array> = {
      [`${PREFIX}f_1.png`]: bytes('1'),
      [`${PREFIX}f_2.png`]: bytes('2'),
    }
    const fetchImpl = (async (input: Request): Promise<Response> => {
      const url = new URL(input.url)
      if (url.searchParams.get('list-type') === '2') {
        return new Response(
          url.searchParams.get('continuation-token') === 'TOKEN2' ? page2 : page1,
          { status: 200 },
        )
      }
      const key = url.pathname.split('/').slice(2).map(decodeURIComponent).join('/')
      return new Response(toBody(objects[key]), { status: 200 })
    }) as unknown as typeof fetch
    const dir = tmpFramesDir()
    const result = await restoreFramesFromR2(CONFIG, DATASET, dir, { fetchImpl })
    expect(result.restored).toBe(2)
    expect(readdirSync(dir).sort()).toEqual(['f_1.png', 'f_2.png'])
  })
})

describe('saveFramesToR2', () => {
  it('uploads only frames not already cached (delta upload)', async () => {
    const { store, fetchImpl } = makeFakeR2({
      [`${PREFIX}f_20240101.png`]: bytes('cached'),
    })
    const dir = tmpFramesDir()
    writeFileSync(join(dir, 'f_20240101.png'), 'local-unchanged')
    writeFileSync(join(dir, 'f_20240108.png'), 'new')
    const result = await saveFramesToR2(CONFIG, DATASET, dir, { fetchImpl })
    expect(result).toEqual({ uploaded: 1, pruned: 0, kept: 2 })
    // The already-cached frame is not re-PUT.
    expect(new TextDecoder().decode(store.get(`${PREFIX}f_20240101.png`))).toBe('cached')
    expect(new TextDecoder().decode(store.get(`${PREFIX}f_20240108.png`))).toBe('new')
  })

  it('prunes the cache to the newest N frames (window-only retention)', async () => {
    const { store, fetchImpl } = makeFakeR2({
      [`${PREFIX}f_20231201.png`]: bytes('old'),
    })
    const dir = tmpFramesDir()
    for (const d of ['20240101', '20240108', '20240115']) {
      writeFileSync(join(dir, `f_${d}.png`), d)
    }
    // Keep only the 2 newest → 20240108, 20240115. The stale cache
    // object 20231201 (no local file) and the older local 20240101
    // are both excluded.
    const result = await saveFramesToR2(CONFIG, DATASET, dir, { fetchImpl, keepFrames: 2 })
    expect(result.kept).toBe(2)
    expect([...store.keys()].sort()).toEqual([
      `${PREFIX}f_20240108.png`,
      `${PREFIX}f_20240115.png`,
    ])
  })

  it('prunes cache objects whose local frame is gone, even with no window', async () => {
    const { store, fetchImpl } = makeFakeR2({
      [`${PREFIX}f_20240101.png`]: bytes('a'),
      [`${PREFIX}f_20240108.png`]: bytes('b'),
    })
    const dir = tmpFramesDir()
    // Only one of the two cached frames still exists locally.
    writeFileSync(join(dir, 'f_20240101.png'), 'a')
    const result = await saveFramesToR2(CONFIG, DATASET, dir, { fetchImpl })
    expect(result.pruned).toBe(1)
    expect([...store.keys()]).toEqual([`${PREFIX}f_20240101.png`])
  })

  it('keeps synthetic (padded) frames out of the cache and prunes stale copies', async () => {
    const { store, fetchImpl } = makeFakeR2({
      [`${PREFIX}f_20240101.png`]: bytes('real'),
      [`${PREFIX}f_20240108.png`]: bytes('stale-synthetic'),
    })
    const dir = tmpFramesDir()
    // Local dir holds a real frame, a freshly-padded synthetic one,
    // and a new real frame.
    writeFileSync(join(dir, 'f_20240101.png'), 'real')
    writeFileSync(join(dir, 'f_20240108.png'), 'synthetic-this-run')
    writeFileSync(join(dir, 'f_20240115.png'), 'real-new')
    const result = await saveFramesToR2(CONFIG, DATASET, dir, {
      fetchImpl,
      excludeNames: ['f_20240108.png'],
    })
    // The synthetic frame is neither uploaded nor retained; the new
    // real frame is uploaded; the stale synthetic cache copy is pruned.
    expect([...store.keys()].sort()).toEqual([
      `${PREFIX}f_20240101.png`,
      `${PREFIX}f_20240115.png`,
    ])
    expect(result.uploaded).toBe(1)
    expect(result.pruned).toBe(1)
    expect(result.kept).toBe(2)
  })

  it('keeps everything when no window budget is given', async () => {
    const { store, fetchImpl } = makeFakeR2()
    const dir = tmpFramesDir()
    for (const d of ['20240101', '20240108', '20240115']) {
      writeFileSync(join(dir, `f_${d}.png`), d)
    }
    const result = await saveFramesToR2(CONFIG, DATASET, dir, { fetchImpl })
    expect(result).toEqual({ uploaded: 3, pruned: 0, kept: 3 })
    expect(store.size).toBe(3)
  })

  it('leaves the cache untouched when the frames dir exists but is empty', async () => {
    const { store, fetchImpl } = makeFakeR2({ [`${PREFIX}f_20240101.png`]: bytes('a') })
    const dir = tmpFramesDir() // created, but holds no frame files
    const result = await saveFramesToR2(CONFIG, DATASET, dir, { fetchImpl })
    expect(result).toEqual({ uploaded: 0, pruned: 0, kept: 0 })
    // The cache must NOT be pruned just because this run produced nothing.
    expect(store.size).toBe(1)
  })

  it('uploads a large window via the bounded worker pool', async () => {
    const { store, fetchImpl } = makeFakeR2()
    const dir = tmpFramesDir()
    const names: string[] = []
    for (let i = 1; i <= 25; i++) {
      const name = `f_202401${String(i).padStart(2, '0')}.png`
      writeFileSync(join(dir, name), `frame-${i}`)
      names.push(name)
    }
    const result = await saveFramesToR2(CONFIG, DATASET, dir, { fetchImpl })
    // Every frame lands despite the pool fanning the PUTs out — more
    // items than the concurrency width exercises the worker loop.
    expect(result.uploaded).toBe(25)
    expect(store.size).toBe(25)
    for (const name of names) expect(store.has(`${PREFIX}${name}`)).toBe(true)
  })

  it('still uploads every frame when concurrency is non-finite', async () => {
    const { store, fetchImpl } = makeFakeR2()
    const dir = tmpFramesDir()
    for (const d of ['20240101', '20240108', '20240115']) {
      writeFileSync(join(dir, `f_${d}.png`), d)
    }
    // A NaN concurrency must clamp to a real worker, not collapse the
    // pool to zero workers and silently skip every upload.
    const result = await saveFramesToR2(CONFIG, DATASET, dir, {
      fetchImpl,
      concurrency: Number.NaN,
    })
    expect(result.uploaded).toBe(3)
    expect(store.size).toBe(3)
  })

  it('is a no-op when the frames directory does not exist', async () => {
    const { store, fetchImpl } = makeFakeR2({ [`${PREFIX}f.png`]: bytes('x') })
    const result = await saveFramesToR2(CONFIG, DATASET, join(tmpFramesDir(), 'nope'), {
      fetchImpl,
    })
    expect(result).toEqual({ uploaded: 0, pruned: 0, kept: 0 })
    // Cache untouched — a missing workdir must not wipe the cache.
    expect(store.size).toBe(1)
  })
})
