/**
 * Tests for `cli/lib/r2-upload.ts` (Phase 3 commit B).
 *
 * Coverage:
 *   - Helper exports: `contentTypeForFile`, `buildObjectUrl`,
 *     `walkBundleFiles`, `parseListKeys`, `validateR2Config`,
 *     `loadR2ConfigFromEnv`.
 *   - `uploadHlsBundle`: walks a tmp HLS bundle, asserts the
 *     SigV4-signed PUT shape (Authorization header present,
 *     Content-Type correct per file), that master.m3u8 is required,
 *     bounded concurrency, error propagation.
 *   - `deleteR2Prefix`: LIST + per-object DELETE flow against a
 *     stubbed S3 XML response.
 *
 * Real R2 round-trips are out of scope — the operator's
 * `--dry-run` against a real bucket exercises live S3 API.
 */

import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildObjectUrl,
  contentTypeForFile,
  deleteR2Object,
  getR2ObjectText,
  listR2KeysPaginated,
  r2ObjectExists,
  deleteR2Prefix,
  loadR2ConfigFromEnv,
  parseListKeys,
  R2UploadError,
  uploadHlsBundle,
  uploadR2Object,
  validateR2Config,
  walkBundleFiles,
  type R2UploadConfig,
} from './r2-upload'

const CONFIG: R2UploadConfig = {
  endpoint: 'https://acct123.r2.cloudflarestorage.com',
  accessKeyId: 'AKIATEST',
  secretAccessKey: 'secret-key',
  bucket: 'terraviz-assets',
}

function makeBundle(): string {
  const tmp = mkdtempSync(join(tmpdir(), 'r2up-'))
  // Replicate the shape of an HLS bundle produced by ffmpeg-hls.
  writeFileSync(join(tmp, 'master.m3u8'), '#EXTM3U\n#EXT-X-VERSION:6\n')
  for (const i of [0, 1, 2]) {
    const dir = join(tmp, `stream_${i}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'playlist.m3u8'), '#EXTM3U\n')
    writeFileSync(join(dir, 'segment_000.ts'), Buffer.alloc(1024))
    writeFileSync(join(dir, 'segment_001.ts'), Buffer.alloc(1024))
  }
  return tmp
}

describe('contentTypeForFile', () => {
  it('maps .m3u8 to application/vnd.apple.mpegurl', () => {
    expect(contentTypeForFile('master.m3u8')).toBe('application/vnd.apple.mpegurl')
    expect(contentTypeForFile('stream_0/playlist.m3u8')).toBe('application/vnd.apple.mpegurl')
  })
  it('maps .ts to video/mp2t', () => {
    expect(contentTypeForFile('segment_000.ts')).toBe('video/mp2t')
    expect(contentTypeForFile('stream_2/segment_042.ts')).toBe('video/mp2t')
  })
  it('falls back to application/octet-stream for unknown extensions', () => {
    expect(contentTypeForFile('readme')).toBe('application/octet-stream')
    expect(contentTypeForFile('thumb.weird')).toBe('application/octet-stream')
  })
  it('is case-insensitive on the extension', () => {
    expect(contentTypeForFile('PLAYLIST.M3U8')).toBe('application/vnd.apple.mpegurl')
  })
})

describe('buildObjectUrl', () => {
  it('uses path-style addressing against the account endpoint', () => {
    expect(buildObjectUrl(CONFIG, 'videos/abc/master.m3u8')).toBe(
      'https://acct123.r2.cloudflarestorage.com/terraviz-assets/videos/abc/master.m3u8',
    )
  })
  it('preserves slashes between path segments but URI-encodes within segments', () => {
    expect(buildObjectUrl(CONFIG, 'videos/some folder/x.ts')).toBe(
      'https://acct123.r2.cloudflarestorage.com/terraviz-assets/videos/some%20folder/x.ts',
    )
  })
})

describe('loadR2ConfigFromEnv / validateR2Config', () => {
  it('reads each variable from process.env', () => {
    const config = loadR2ConfigFromEnv({
      R2_S3_ENDPOINT: 'https://x.r2.cloudflarestorage.com/',
      R2_ACCESS_KEY_ID: 'k',
      R2_SECRET_ACCESS_KEY: 's',
      CATALOG_R2_BUCKET: 'custom-bucket',
    })
    expect(config.endpoint).toBe('https://x.r2.cloudflarestorage.com') // trailing slash trimmed
    expect(config.accessKeyId).toBe('k')
    expect(config.secretAccessKey).toBe('s')
    expect(config.bucket).toBe('custom-bucket')
  })
  it('defaults the bucket to terraviz-assets when CATALOG_R2_BUCKET is unset', () => {
    expect(loadR2ConfigFromEnv({ R2_S3_ENDPOINT: 'x', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's' }).bucket).toBe(
      'terraviz-assets',
    )
  })
  it('validateR2Config throws when any credential is missing', () => {
    expect(() => validateR2Config({ ...CONFIG, accessKeyId: '' })).toThrow(/R2_ACCESS_KEY_ID/)
    expect(() => validateR2Config({ ...CONFIG, secretAccessKey: '' })).toThrow(/R2_SECRET_ACCESS_KEY/)
    expect(() => validateR2Config({ ...CONFIG, endpoint: '' })).toThrow(/R2_S3_ENDPOINT/)
  })
})

describe('walkBundleFiles', () => {
  it('returns relative paths + sizes for every file in the bundle', () => {
    const dir = makeBundle()
    try {
      const files = walkBundleFiles(dir)
      const relatives = files.map(f => f.relative.replace(/\\/g, '/')).sort()
      expect(relatives).toEqual([
        'master.m3u8',
        'stream_0/playlist.m3u8',
        'stream_0/segment_000.ts',
        'stream_0/segment_001.ts',
        'stream_1/playlist.m3u8',
        'stream_1/segment_000.ts',
        'stream_1/segment_001.ts',
        'stream_2/playlist.m3u8',
        'stream_2/segment_000.ts',
        'stream_2/segment_001.ts',
      ])
      for (const f of files) {
        expect(f.size).toBeGreaterThanOrEqual(0)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('uploadHlsBundle', () => {
  it('PUTs every file with the correct Content-Type + SigV4 Authorization header', async () => {
    const dir = makeBundle()
    const puts: Array<{ url: string; headers: Headers }> = []
    const fetchImpl = vi.fn(async (req: Request) => {
      puts.push({ url: req.url, headers: req.headers })
      return new Response(null, { status: 200 })
    })
    try {
      const result = await uploadHlsBundle(CONFIG, dir, 'videos/test-asset', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        concurrency: 4,
      })
      // 10 files total per makeBundle.
      expect(puts).toHaveLength(10)
      expect(result.masterKey).toBe('videos/test-asset/master.m3u8')
      expect(result.keys).toHaveLength(10)
      // Every PUT goes to <endpoint>/<bucket>/<prefix>/<file>.
      for (const p of puts) {
        expect(p.url.startsWith(`${CONFIG.endpoint}/${CONFIG.bucket}/videos/test-asset/`)).toBe(true)
        const auth = p.headers.get('Authorization') ?? ''
        // aws4fetch attaches an AWS4-HMAC-SHA256 signature on
        // signed requests.
        expect(auth).toMatch(/^AWS4-HMAC-SHA256 /)
      }
      // Content-Type is per-file.
      const masterPut = puts.find(p => p.url.endsWith('/master.m3u8'))
      expect(masterPut?.headers.get('Content-Type')).toBe('application/vnd.apple.mpegurl')
      const segmentPut = puts.find(p => p.url.endsWith('segment_000.ts') && p.url.includes('stream_0'))
      expect(segmentPut?.headers.get('Content-Type')).toBe('video/mp2t')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('respects the concurrency limit', async () => {
    const dir = makeBundle()
    let inFlight = 0
    let maxObserved = 0
    const fetchImpl = vi.fn(async () => {
      inFlight++
      maxObserved = Math.max(maxObserved, inFlight)
      await new Promise(r => setTimeout(r, 5))
      inFlight--
      return new Response(null, { status: 200 })
    })
    try {
      await uploadHlsBundle(CONFIG, dir, 'videos/x', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        concurrency: 3,
      })
      expect(maxObserved).toBeLessThanOrEqual(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('emits onProgress callbacks with running totals', async () => {
    const dir = makeBundle()
    const progress: Array<{ done: number; total: number; key: string }> = []
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }))
    try {
      await uploadHlsBundle(CONFIG, dir, 'videos/x', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        onProgress: info => progress.push({ done: info.done, total: info.total, key: info.key }),
      })
      expect(progress).toHaveLength(10)
      // Last callback reports the final running total.
      expect(progress[progress.length - 1].done).toBe(10)
      expect(progress[0].total).toBe(10)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('throws R2UploadError with the failing key on non-2xx', async () => {
    const dir = makeBundle()
    const fetchImpl = vi.fn(async (req: Request) => {
      if (req.url.includes('master.m3u8')) {
        return new Response('AccessDenied', { status: 403 })
      }
      return new Response(null, { status: 200 })
    })
    try {
      const err = await uploadHlsBundle(CONFIG, dir, 'videos/x', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }).catch(e => e)
      expect(err).toBeInstanceOf(R2UploadError)
      expect(err.status).toBe(403)
      expect(err.key).toContain('master.m3u8')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses when master.m3u8 is missing from the bundle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'r2up-'))
    writeFileSync(join(dir, 'stream_0_playlist.m3u8'), '#EXTM3U\n') // no master
    const fetchImpl = vi.fn()
    try {
      await expect(
        uploadHlsBundle(CONFIG, dir, 'videos/x', { fetchImpl: fetchImpl as unknown as typeof fetch }),
      ).rejects.toThrow(/master\.m3u8 not found/)
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses when the bundle directory is empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'r2up-'))
    const fetchImpl = vi.fn()
    try {
      await expect(
        uploadHlsBundle(CONFIG, dir, 'videos/x', { fetchImpl: fetchImpl as unknown as typeof fetch }),
      ).rejects.toThrow(/is empty/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('throws at config-validation when credentials are missing', async () => {
    const dir = makeBundle()
    const fetchImpl = vi.fn()
    try {
      await expect(
        uploadHlsBundle(
          { ...CONFIG, accessKeyId: '' },
          dir,
          'videos/x',
          { fetchImpl: fetchImpl as unknown as typeof fetch },
        ),
      ).rejects.toMatchObject({ name: 'R2UploadError' })
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('parseListKeys', () => {
  it('extracts keys from an S3-style ListObjectsV2 XML body', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>terraviz-assets</Name>
  <Contents><Key>videos/a/master.m3u8</Key><Size>23</Size></Contents>
  <Contents><Key>videos/a/stream_0/segment_000.ts</Key><Size>1024</Size></Contents>
  <Contents><Key>videos/a/stream_0/segment_001.ts</Key><Size>1024</Size></Contents>
</ListBucketResult>`
    expect(parseListKeys(xml)).toEqual([
      'videos/a/master.m3u8',
      'videos/a/stream_0/segment_000.ts',
      'videos/a/stream_0/segment_001.ts',
    ])
  })
  it('decodes the standard XML entities in key names', () => {
    const xml = `<Contents><Key>videos/a&amp;b/master.m3u8</Key></Contents>`
    expect(parseListKeys(xml)).toEqual(['videos/a&b/master.m3u8'])
  })
  it('does not double-unescape literal entity-looking sequences (CodeQL fix)', () => {
    // A key with the literal text `&quot;` in it. S3 encodes the
    // bare `&` in the XML response as `&amp;`, so the wire payload
    // is `&amp;quot;`. Decoder must yield the original literal
    // `&quot;`, NOT collapse through `&quot;` → `"`.
    expect(parseListKeys(`<Contents><Key>k&amp;quot;v</Key></Contents>`)).toEqual([
      'k&quot;v',
    ])
    // Same for the other entities that follow `&` in the
    // alphabet — `&amp;apos;` must round-trip to literal `&apos;`,
    // not to `'`.
    expect(parseListKeys(`<Contents><Key>k&amp;apos;v</Key></Contents>`)).toEqual([
      "k&apos;v",
    ])
    expect(parseListKeys(`<Contents><Key>k&amp;lt;v</Key></Contents>`)).toEqual([
      'k&lt;v',
    ])
    expect(parseListKeys(`<Contents><Key>k&amp;gt;v</Key></Contents>`)).toEqual([
      'k&gt;v',
    ])
  })
  it('returns [] for an empty bucket', () => {
    expect(parseListKeys('<ListBucketResult></ListBucketResult>')).toEqual([])
  })
})

describe('deleteR2Prefix', () => {
  it('LISTs the prefix then DELETEs each object', async () => {
    const calls: Array<{ method: string; url: string }> = []
    const fetchImpl = vi.fn(async (req: Request) => {
      calls.push({ method: req.method, url: req.url })
      if (req.method === 'GET') {
        return new Response(
          `<ListBucketResult>
            <Contents><Key>videos/x/master.m3u8</Key></Contents>
            <Contents><Key>videos/x/stream_0/segment_000.ts</Key></Contents>
          </ListBucketResult>`,
          { status: 200 },
        )
      }
      return new Response(null, { status: 204 })
    })
    const out = await deleteR2Prefix(CONFIG, 'videos/x', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(out.deleted).toBe(2)
    expect(calls[0].method).toBe('GET')
    expect(calls[0].url).toMatch(/list-type=2/)
    expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(2)
  })

  it('treats DELETE 404 as success (idempotent re-run)', async () => {
    const fetchImpl = vi.fn(async (req: Request) => {
      if (req.method === 'GET') {
        return new Response(`<ListBucketResult><Contents><Key>videos/x/master.m3u8</Key></Contents></ListBucketResult>`, {
          status: 200,
        })
      }
      return new Response(null, { status: 404 })
    })
    const out = await deleteR2Prefix(CONFIG, 'videos/x', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(out.deleted).toBe(1)
  })

  it('returns 0 when the prefix is empty', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('<ListBucketResult></ListBucketResult>', { status: 200 }),
    )
    const out = await deleteR2Prefix(CONFIG, 'videos/x', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(out.deleted).toBe(0)
  })

  it('throws R2UploadError on a failed DELETE', async () => {
    const fetchImpl = vi.fn(async (req: Request) => {
      if (req.method === 'GET') {
        return new Response(`<ListBucketResult><Contents><Key>videos/x/master.m3u8</Key></Contents></ListBucketResult>`, {
          status: 200,
        })
      }
      return new Response('access denied', { status: 403 })
    })
    await expect(
      deleteR2Prefix(CONFIG, 'videos/x', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ name: 'R2UploadError', status: 403 })
  })

  it('translates LIST network errors into R2UploadError (3/M)', async () => {
    // A raw TypeError from undici would escape the helper's
    // contract and confuse callers. Wrap it as R2UploadError
    // with status=null + key=prefix for consistent attribution.
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed: ECONNREFUSED')
    })
    const err = await deleteR2Prefix(CONFIG, 'videos/x', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch(e => e)
    expect(err).toBeInstanceOf(R2UploadError)
    expect(err.status).toBeNull()
    expect(err.key).toBe('videos/x/')
    expect(err.message).toMatch(/LIST .* unreachable/)
  })

  it('translates per-object DELETE network errors into R2UploadError (3/M)', async () => {
    const fetchImpl = vi.fn(async (req: Request) => {
      if (req.method === 'GET') {
        return new Response(
          `<ListBucketResult><Contents><Key>videos/x/master.m3u8</Key></Contents></ListBucketResult>`,
          { status: 200 },
        )
      }
      throw new TypeError('fetch failed: ECONNRESET')
    })
    const err = await deleteR2Prefix(CONFIG, 'videos/x', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch(e => e)
    expect(err).toBeInstanceOf(R2UploadError)
    expect(err.status).toBeNull()
    expect(err.key).toBe('videos/x/master.m3u8')
    expect(err.message).toMatch(/DELETE .* unreachable/)
  })
})

describe('uploadR2Object (3b/F)', () => {
  // Single-file PUT primitive companion to uploadHlsBundle. Used
  // by the 3b/G migrate-r2-assets pump for one-thumbnail-per-row
  // uploads (no master playlist, no bundle walk).

  it('PUTs the body to the signed URL with the right content-type', async () => {
    let captured: { url: string; method: string; contentType: string; body: ArrayBuffer } | null = null
    const fetchImpl = vi.fn(async (req: Request) => {
      captured = {
        url: req.url,
        method: req.method,
        contentType: req.headers.get('content-type') ?? '',
        body: await req.arrayBuffer(),
      }
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch
    const payload = new TextEncoder().encode('fake png bytes')
    const result = await uploadR2Object(
      CONFIG,
      'datasets/DS001/thumbnail.png',
      payload,
      'image/png',
      { fetchImpl },
    )
    expect(result.key).toBe('datasets/DS001/thumbnail.png')
    expect(result.bytes).toBe(payload.byteLength)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(captured).not.toBeNull()
    expect(captured!.method).toBe('PUT')
    expect(captured!.contentType).toBe('image/png')
    // Path-style addressing: <endpoint>/<bucket>/<key-with-slashes>.
    expect(captured!.url).toBe(
      'https://acct123.r2.cloudflarestorage.com/terraviz-assets/datasets/DS001/thumbnail.png',
    )
    expect(new Uint8Array(captured!.body)).toEqual(payload)
  })

  it('throws R2UploadError on a non-2xx response with the key + status', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('AccessDenied', { status: 403 }),
    ) as unknown as typeof fetch
    const err = await uploadR2Object(
      CONFIG,
      'datasets/DS001/legend.png',
      new Uint8Array([1, 2, 3]),
      'image/png',
      { fetchImpl },
    ).catch(e => e) as R2UploadError
    expect(err).toBeInstanceOf(R2UploadError)
    expect(err.status).toBe(403)
    expect(err.key).toBe('datasets/DS001/legend.png')
    expect(err.message).toMatch(/PUT datasets\/DS001\/legend\.png failed \(403\)/)
    expect(err.message).toContain('AccessDenied')
  })

  it('wraps a network throw as R2UploadError with the key + null status', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('socket hang up')
    }) as unknown as typeof fetch
    const err = await uploadR2Object(
      CONFIG,
      'datasets/DS001/caption.vtt',
      new Uint8Array(10),
      'text/vtt',
      { fetchImpl, retryDelayMs: 0 },
    ).catch(e => e) as R2UploadError
    expect(err).toBeInstanceOf(R2UploadError)
    expect(err.status).toBeNull()
    expect(err.key).toBe('datasets/DS001/caption.vtt')
    expect(err.message).toMatch(/PUT .* unreachable.*socket hang up/)
  })

  it('refuses to PUT when config is incomplete', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const err = await uploadR2Object(
      { ...CONFIG, accessKeyId: '' },
      'datasets/DS001/thumbnail.png',
      new Uint8Array(10),
      'image/png',
      { fetchImpl },
    ).catch(e => e) as R2UploadError
    expect(err).toBeInstanceOf(R2UploadError)
    expect(err.message).toContain('R2_ACCESS_KEY_ID')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('preserves UTF-8 multibyte sequences through the ArrayBuffer round-trip', async () => {
    // Captions and other text assets are UTF-8. Guard against a
    // subtle bug where the .buffer.slice copy would silently
    // truncate when byteOffset > 0.
    let capturedBody: ArrayBuffer | null = null
    const fetchImpl = vi.fn(async (req: Request) => {
      capturedBody = await req.arrayBuffer()
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch
    const text = 'WEBVTT\n\n1\n00:00:00.500 --> 00:00:01.200\nÁllo, mañana — ¿qué tal?\n'
    const payload = new TextEncoder().encode(text)
    await uploadR2Object(
      CONFIG,
      'datasets/DS001/caption.vtt',
      payload,
      'text/vtt',
      { fetchImpl },
    )
    expect(capturedBody).not.toBeNull()
    expect(new TextDecoder('utf-8').decode(new Uint8Array(capturedBody!))).toBe(text)
  })
})

describe('deleteR2Object (3b/I)', () => {
  // Single-object DELETE helper used by the 3b/I rollback path.
  // One HTTP round-trip instead of LIST + DELETE-each, scoped
  // to an exact key so unrelated objects sharing a prefix
  // aren't touched.

  it('issues DELETE against the path-style URL with SigV4', async () => {
    let captured: { url: string; method: string; auth: string } | null = null
    const fetchImpl = vi.fn(async (req: Request) => {
      captured = {
        url: req.url,
        method: req.method,
        auth: req.headers.get('Authorization') ?? '',
      }
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const result = await deleteR2Object(
      CONFIG,
      'datasets/DS001/thumbnail.jpg',
      { fetchImpl },
    )
    expect(result.key).toBe('datasets/DS001/thumbnail.jpg')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(captured).not.toBeNull()
    expect(captured!.method).toBe('DELETE')
    expect(captured!.url).toBe(
      'https://acct123.r2.cloudflarestorage.com/terraviz-assets/datasets/DS001/thumbnail.jpg',
    )
    expect(captured!.auth).toMatch(/^AWS4-HMAC-SHA256 /)
  })

  it('throws R2UploadError on a 403 with the key + status preserved', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('AccessDenied', { status: 403 }),
    ) as unknown as typeof fetch
    const err = await deleteR2Object(
      CONFIG,
      'datasets/DS001/thumbnail.jpg',
      { fetchImpl },
    ).catch(e => e) as R2UploadError
    expect(err).toBeInstanceOf(R2UploadError)
    expect(err.status).toBe(403)
    expect(err.key).toBe('datasets/DS001/thumbnail.jpg')
  })

  it('throws R2UploadError on a network throw with status=null', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('socket hang up')
    }) as unknown as typeof fetch
    const err = await deleteR2Object(
      CONFIG,
      'datasets/DS001/legend.png',
      { fetchImpl, retryDelayMs: 0 },
    ).catch(e => e) as R2UploadError
    expect(err).toBeInstanceOf(R2UploadError)
    expect(err.status).toBeNull()
    expect(err.message).toMatch(/DELETE .* unreachable.*socket hang up/)
  })

  it('refuses to DELETE when config is incomplete', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const err = await deleteR2Object(
      { ...CONFIG, secretAccessKey: '' },
      'datasets/DS001/thumbnail.jpg',
      { fetchImpl },
    ).catch(e => e) as R2UploadError
    expect(err).toBeInstanceOf(R2UploadError)
    expect(err.message).toContain('R2_SECRET_ACCESS_KEY')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('r2ObjectExists', () => {
  it('returns true on 2xx, false on 404', async () => {
    const ok = vi.fn(async () => new Response(null, { status: 200 }))
    expect(await r2ObjectExists(CONFIG, 'videos/x/frames/sha256/a.png', { fetchImpl: ok as unknown as typeof fetch })).toBe(
      true,
    )
    const missing = vi.fn(async () => new Response(null, { status: 404 }))
    expect(
      await r2ObjectExists(CONFIG, 'videos/x/frames/sha256/a.png', { fetchImpl: missing as unknown as typeof fetch }),
    ).toBe(false)
  })

  it('throws on a persistent unexpected error status (not 404), after retrying', async () => {
    const err = vi.fn(async () => new Response(null, { status: 500 }))
    await expect(
      r2ObjectExists(CONFIG, 'videos/x/frames/sha256/a.png', {
        fetchImpl: err as unknown as typeof fetch,
        attempts: 3,
        retryDelayMs: 0,
      }),
    ).rejects.toBeInstanceOf(R2UploadError)
    expect(err).toHaveBeenCalledTimes(3) // 5xx is retried
  })

  it('retries a transient 429 then returns true (R2 read-rate throttle)', async () => {
    let n = 0
    const flaky = vi.fn(async () => (++n < 2 ? new Response(null, { status: 429 }) : new Response(null, { status: 200 })))
    expect(
      await r2ObjectExists(CONFIG, 'videos/x/frames/sha256/a.png', {
        fetchImpl: flaky as unknown as typeof fetch,
        retryDelayMs: 0,
      }),
    ).toBe(true)
    expect(flaky).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a deterministic 4xx (403 fails fast — only 429/5xx are retried)', async () => {
    const forbidden = vi.fn(async () => new Response(null, { status: 403 }))
    await expect(
      r2ObjectExists(CONFIG, 'videos/x/frames/sha256/a.png', {
        fetchImpl: forbidden as unknown as typeof fetch,
        retryDelayMs: 0,
      }),
    ).rejects.toBeInstanceOf(R2UploadError)
    expect(forbidden).toHaveBeenCalledTimes(1)
  })
})

describe('getR2ObjectText', () => {
  it('returns the body on 2xx, null on 404', async () => {
    const ok = vi.fn(async () => new Response('[{"index":0}]', { status: 200 }))
    expect(await getR2ObjectText(CONFIG, 'k.json', { fetchImpl: ok as unknown as typeof fetch })).toBe('[{"index":0}]')
    const missing = vi.fn(async () => new Response(null, { status: 404 }))
    expect(await getR2ObjectText(CONFIG, 'k.json', { fetchImpl: missing as unknown as typeof fetch })).toBeNull()
  })
})

describe('listR2KeysPaginated', () => {
  function page(keys: string[], nextToken?: string): string {
    const contents = keys.map(k => `<Contents><Key>${k}</Key></Contents>`).join('')
    const truncated = nextToken
      ? `<IsTruncated>true</IsTruncated><NextContinuationToken>${nextToken}</NextContinuationToken>`
      : '<IsTruncated>false</IsTruncated>'
    return `<?xml version="1.0"?><ListBucketResult>${truncated}${contents}</ListBucketResult>`
  }

  it('follows NextContinuationToken across pages', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (req: Request) => {
      const url = typeof req === 'string' ? req : req.url
      calls.push(url)
      if (url.includes('continuation-token=PAGE2')) {
        return new Response(page(['videos/d/frames/sha256/c.png']), { status: 200 })
      }
      return new Response(page(['videos/d/frames/sha256/a.png', 'videos/d/frames/sha256/b.png'], 'PAGE2'), {
        status: 200,
      })
    })
    const keys = await listR2KeysPaginated(CONFIG, 'videos/d/frames/sha256/', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(keys).toEqual([
      'videos/d/frames/sha256/a.png',
      'videos/d/frames/sha256/b.png',
      'videos/d/frames/sha256/c.png',
    ])
    expect(calls).toHaveLength(2)
  })

  it('throws R2UploadError on a persistent non-2xx list, after retrying the 5xx', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }))
    await expect(
      listR2KeysPaginated(CONFIG, 'videos/d/frames/sha256/', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        attempts: 3,
        retryDelayMs: 0,
      }),
    ).rejects.toBeInstanceOf(R2UploadError)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('retries a transient 500 on the first page then succeeds', async () => {
    let n = 0
    const fetchImpl = vi.fn(async () => {
      if (++n === 1) return new Response('err', { status: 500 })
      return new Response(page(['videos/d/frames/sha256/a.png']), { status: 200 })
    })
    const keys = await listR2KeysPaginated(CONFIG, 'videos/d/frames/sha256/', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryDelayMs: 0,
    })
    expect(keys).toEqual(['videos/d/frames/sha256/a.png'])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
