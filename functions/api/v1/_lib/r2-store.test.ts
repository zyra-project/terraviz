/**
 * Tests for the R2 storage helpers.
 *
 * Coverage:
 *   - `buildAssetKey` produces content-addressed paths in the
 *     `datasets/{id}/by-digest/sha256/{hex}/{base}.{ext}` shape and
 *     rejects malformed hex / ext.
 *   - `presignPut` in MOCK_R2 mode returns a deterministic local URL
 *     and stamps an ISO 8601 expiry the right number of seconds in
 *     the future.
 *   - `presignPut` in real-credential mode produces a stable SigV4
 *     query string given a fixed clock — the canonical query
 *     parameters are present, the signature is 64 hex chars, and
 *     identical inputs produce identical signatures (regression
 *     gate against accidentally non-deterministic signing).
 *   - Wrong secret → different signature, but the rest of the URL
 *     is unchanged.
 *   - `presignPut` with no MOCK_R2 and no S3 credentials raises a
 *     clear error rather than emitting a malformed URL.
 *   - `verifyContentDigest` returns ok / mismatch / missing /
 *     malformed_claim / binding_missing for the four shapes the
 *     complete-handler in Commit D will branch on.
 */

import { describe, expect, it } from 'vitest'
import {
  buildAssetKey,
  isVideoSourceKey,
  MOCK_R2_HOST,
  presignPut,
  R2_PUT_TTL_SECONDS,
  verifyContentDigest,
  type R2Env,
} from './r2-store'

const FIXED_NOW = new Date('2026-04-29T12:00:00.000Z')
const SHA64_A = 'a'.repeat(64)
const SHA64_B = 'b'.repeat(64)

const REAL_CREDS: R2Env = {
  CATALOG_R2_BUCKET: 'terraviz-assets',
  R2_S3_ENDPOINT: 'https://acct1234.r2.cloudflarestorage.com',
  R2_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  R2_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bbPxRfiCYEXAMPLEKEY',
}

describe('buildAssetKey', () => {
  it('emits content-addressed paths', () => {
    expect(buildAssetKey('DS001', 'data', SHA64_A, 'mp4')).toBe(
      `datasets/DS001/by-digest/sha256/${SHA64_A}/asset.mp4`,
    )
    expect(buildAssetKey('DS001', 'thumbnail', SHA64_A, 'png')).toBe(
      `datasets/DS001/by-digest/sha256/${SHA64_A}/thumbnail.png`,
    )
    expect(buildAssetKey('DS001', 'sphere_thumbnail', SHA64_A, 'webp')).toBe(
      `datasets/DS001/by-digest/sha256/${SHA64_A}/sphere-thumbnail.webp`,
    )
    expect(buildAssetKey('DS001', 'caption', SHA64_A, 'vtt')).toBe(
      `datasets/DS001/by-digest/sha256/${SHA64_A}/caption.vtt`,
    )
    expect(buildAssetKey('DS001', 'legend', SHA64_A, 'png')).toBe(
      `datasets/DS001/by-digest/sha256/${SHA64_A}/legend.png`,
    )
  })

  it('rejects malformed hex', () => {
    expect(() => buildAssetKey('DS001', 'data', 'too-short', 'mp4')).toThrow(/64 lowercase hex/)
    expect(() => buildAssetKey('DS001', 'data', SHA64_A.toUpperCase(), 'mp4')).toThrow(/64 lowercase hex/)
  })

  it('rejects malformed ext', () => {
    expect(() => buildAssetKey('DS001', 'data', SHA64_A, '')).toThrow(/1-8 lowercase/)
    expect(() => buildAssetKey('DS001', 'data', SHA64_A, 'MP4')).toThrow(/1-8 lowercase/)
    expect(() => buildAssetKey('DS001', 'data', SHA64_A, 'too-long-ext')).toThrow(/1-8 lowercase/)
  })
})

describe('isVideoSourceKey', () => {
  // Both segments must be valid Crockford ULIDs (the alphabet
  // excludes I, L, O, U). 'X' is in V-Z so X×26 is a legal ULID
  // shape; '0' through '9' and the rest of the alphabet round
  // out the test fixtures below.
  const DS = '01HXAAAAAAAAAAAAAAAAAAAAAA'
  const UP = '01HYAAAAAAAAAAAAAAAAAAAAAA'

  it('accepts the canonical uploads/{ULID}/{ULID}/source.mp4 shape', () => {
    expect(isVideoSourceKey(`uploads/${DS}/${UP}/source.mp4`)).toBe(true)
  })

  it('rejects the obsolete one-level uploads/{ULID}/source.mp4 shape', () => {
    // Pre-3pd-review3/A wrote source MP4s at the dataset-only
    // path. Accepting that here would let isVideoSourceKey()
    // route a malformed asset_uploads row down the video-source
    // dispatch branch even though no /asset handler ever produces
    // such a key. PR #112 Copilot 3pd-followup.
    expect(isVideoSourceKey(`uploads/${DS}/source.mp4`)).toBe(false)
  })

  it('rejects shapes whose path segments aren’t ULIDs', () => {
    expect(isVideoSourceKey('uploads/not-a-ulid/01HYAAAAAAAAAAAAAAAAAAAAAA/source.mp4')).toBe(false)
    expect(isVideoSourceKey(`uploads/${DS}/not-a-ulid/source.mp4`)).toBe(false)
  })

  it('rejects deeper paths and adjacent filenames', () => {
    expect(isVideoSourceKey(`uploads/${DS}/${UP}/sub/source.mp4`)).toBe(false)
    expect(isVideoSourceKey(`uploads/${DS}/${UP}/source.mov`)).toBe(false)
  })

  it('rejects keys outside the uploads/ namespace', () => {
    expect(isVideoSourceKey(`datasets/${DS}/by-digest/sha256/abc/asset.mp4`)).toBe(false)
    expect(isVideoSourceKey(`videos/${DS}/${UP}/master.m3u8`)).toBe(false)
  })
})

describe('presignPut — mock mode', () => {
  it('returns a deterministic local URL', async () => {
    const env: R2Env = { MOCK_R2: 'true' }
    const result = await presignPut(env, 'datasets/DS001/by-digest/sha256/aaa/asset.mp4', {
      now: FIXED_NOW,
      contentType: 'video/mp4',
    })
    expect(result.method).toBe('PUT')
    expect(result.url).toContain(MOCK_R2_HOST)
    expect(result.url).toContain('terraviz-assets/datasets/DS001/by-digest/sha256/aaa/asset.mp4')
    expect(result.headers['Content-Type']).toBe('video/mp4')
    expect(result.key).toBe('datasets/DS001/by-digest/sha256/aaa/asset.mp4')
  })

  it('stamps an ISO 8601 expiry TTL_SECONDS in the future', async () => {
    const env: R2Env = { MOCK_R2: 'true' }
    const result = await presignPut(env, 'k', { now: FIXED_NOW })
    const exp = new Date(result.expires_at).getTime()
    expect(exp - FIXED_NOW.getTime()).toBe(R2_PUT_TTL_SECONDS * 1000)
  })

  it('honours bucket override', async () => {
    const env: R2Env = { MOCK_R2: 'true', CATALOG_R2_BUCKET: 'alt-bucket' }
    const result = await presignPut(env, 'k', { now: FIXED_NOW })
    expect(result.url).toContain('/alt-bucket/k')
  })
})

describe('presignPut — SigV4', () => {
  it('emits a URL with the canonical query parameters', async () => {
    const result = await presignPut(REAL_CREDS, 'datasets/DS001/by-digest/sha256/aaa/asset.mp4', {
      now: FIXED_NOW,
      contentType: 'video/mp4',
    })
    const url = new URL(result.url)
    expect(url.origin).toBe('https://acct1234.r2.cloudflarestorage.com')
    expect(url.pathname).toBe('/terraviz-assets/datasets/DS001/by-digest/sha256/aaa/asset.mp4')
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      'AKIAIOSFODNN7EXAMPLE/20260429/auto/s3/aws4_request',
    )
    expect(url.searchParams.get('X-Amz-Date')).toBe('20260429T120000Z')
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(R2_PUT_TTL_SECONDS))
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host')
    const sig = url.searchParams.get('X-Amz-Signature')
    expect(sig).toMatch(/^[0-9a-f]{64}$/)
  })

  it('signs without content-type when none is provided', async () => {
    const result = await presignPut(REAL_CREDS, 'k', { now: FIXED_NOW })
    const url = new URL(result.url)
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
    expect(result.headers).toEqual({})
  })

  it('produces deterministic signatures for fixed inputs', async () => {
    const a = await presignPut(REAL_CREDS, 'k', { now: FIXED_NOW, contentType: 'image/png' })
    const b = await presignPut(REAL_CREDS, 'k', { now: FIXED_NOW, contentType: 'image/png' })
    expect(a.url).toBe(b.url)
  })

  it('different secret → different signature, same canonical request', async () => {
    const altCreds: R2Env = { ...REAL_CREDS, R2_SECRET_ACCESS_KEY: 'OTHER_SECRET_KEY' }
    const a = await presignPut(REAL_CREDS, 'k', { now: FIXED_NOW })
    const b = await presignPut(altCreds, 'k', { now: FIXED_NOW })
    const sigA = new URL(a.url).searchParams.get('X-Amz-Signature')
    const sigB = new URL(b.url).searchParams.get('X-Amz-Signature')
    expect(sigA).not.toBe(sigB)
    // Path + non-signature query bits unchanged.
    expect(new URL(a.url).pathname).toBe(new URL(b.url).pathname)
    expect(new URL(a.url).searchParams.get('X-Amz-Credential')).toBe(
      new URL(b.url).searchParams.get('X-Amz-Credential'),
    )
  })

  it('encodes special characters in the key per RFC 3986', async () => {
    const result = await presignPut(REAL_CREDS, 'datasets/with spaces/file.mp4', {
      now: FIXED_NOW,
    })
    const url = new URL(result.url)
    // Spaces become %20 (not '+'), and the slash separators are preserved.
    expect(url.pathname).toBe('/terraviz-assets/datasets/with%20spaces/file.mp4')
  })

  it('throws when neither MOCK_R2 nor full credentials are configured', async () => {
    const partial: R2Env = {
      R2_S3_ENDPOINT: 'https://x.r2.cloudflarestorage.com',
      // no access key
    }
    await expect(presignPut(partial, 'k')).rejects.toThrow(/MOCK_R2=true|R2_ACCESS_KEY_ID/)
  })
})

describe('verifyContentDigest', () => {
  function makeBucket(content: ArrayBuffer | null): R2Bucket {
    return {
      get: async (_key: string) => {
        if (!content) return null
        return {
          arrayBuffer: async () => content,
        } as unknown as R2ObjectBody
      },
    } as unknown as R2Bucket
  }

  it('returns ok with the recomputed digest when the object matches', async () => {
    const bytes = new TextEncoder().encode('hello world')
    const env: R2Env = { CATALOG_R2: makeBucket(bytes.buffer as ArrayBuffer) }
    // SHA-256("hello world") (well-known): b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
    const result = await verifyContentDigest(
      env,
      'k',
      'sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    )
    expect(result).toEqual({
      ok: true,
      digest: 'sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
      size: bytes.byteLength,
    })
  })

  it('returns mismatch when the bytes hash to a different digest', async () => {
    const bytes = new TextEncoder().encode('hello world')
    const env: R2Env = { CATALOG_R2: makeBucket(bytes.buffer as ArrayBuffer) }
    const result = await verifyContentDigest(env, 'k', `sha256:${SHA64_A}`)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('mismatch')
    if (result.reason !== 'mismatch') return
    expect(result.claimed).toBe(`sha256:${SHA64_A}`)
    expect(result.actual).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(result.actual).not.toBe(`sha256:${SHA64_A}`)
  })

  it('returns missing when the object is absent', async () => {
    const env: R2Env = { CATALOG_R2: makeBucket(null) }
    const result = await verifyContentDigest(env, 'k', `sha256:${SHA64_A}`)
    expect(result).toEqual({ ok: false, reason: 'missing' })
  })

  it('returns malformed_claim for non-sha256 inputs', async () => {
    const env: R2Env = { CATALOG_R2: makeBucket(new ArrayBuffer(0)) }
    expect(await verifyContentDigest(env, 'k', 'sha256:zzz')).toEqual({
      ok: false,
      reason: 'malformed_claim',
    })
    expect(await verifyContentDigest(env, 'k', 'md5:abc')).toEqual({
      ok: false,
      reason: 'malformed_claim',
    })
    expect(await verifyContentDigest(env, 'k', SHA64_A)).toEqual({
      ok: false,
      reason: 'malformed_claim',
    })
    expect(await verifyContentDigest(env, 'k', `sha256:${SHA64_B.toUpperCase()}`)).toEqual({
      ok: false,
      reason: 'malformed_claim',
    })
  })

  it('returns binding_missing when CATALOG_R2 is unwired', async () => {
    const env: R2Env = {}
    const result = await verifyContentDigest(env, 'k', `sha256:${SHA64_A}`)
    expect(result).toEqual({ ok: false, reason: 'binding_missing' })
  })
})
