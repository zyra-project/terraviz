/**
 * Tests for the R2 public-URL resolver.
 *
 * Coverage:
 *   - `R2_PUBLIC_BASE` wins when set; trailing slash is stripped.
 *   - `MOCK_R2=true` falls through to the local stub host
 *     (bucket-prefixed path so the test suite can assert URLs).
 *   - `R2_S3_ENDPOINT` is the last-resort fallback; trailing slash
 *     stripped.
 *   - All three return null when none are configured.
 *   - Key segments encode special characters; `/` separators are
 *     preserved.
 *   - `resolveAssetRef` strips `r2:` and dispatches to
 *     `resolveR2PublicUrl`; bare URLs pass through; null/undefined
 *     return null.
 */

import { describe, expect, it } from 'vitest'
import {
  buildFrameRecallUrl,
  buildFramesRedirectTemplate,
  encodeR2Key,
  resolveAssetRef,
  resolveAssetRefStrict,
  resolveHttpAssetUrl,
  resolveR2HlsPublicUrl,
  resolveR2PublicUrl,
} from './r2-public-url'
import type { CatalogEnv } from './env'

describe('resolveR2PublicUrl', () => {
  const KEY = 'datasets/DS001/by-digest/sha256/aaa/asset.png'

  it('uses R2_PUBLIC_BASE when set', () => {
    const env: CatalogEnv = {
      R2_PUBLIC_BASE: 'https://assets.example.com',
      CATALOG_R2_BUCKET: 'terraviz-assets',
    }
    expect(resolveR2PublicUrl(env, KEY)).toBe(`https://assets.example.com/${KEY}`)
  })

  it('strips a trailing slash from R2_PUBLIC_BASE', () => {
    const env: CatalogEnv = { R2_PUBLIC_BASE: 'https://assets.example.com/' }
    expect(resolveR2PublicUrl(env, KEY)).toBe(`https://assets.example.com/${KEY}`)
  })

  it('falls through to MOCK_R2 host when R2_PUBLIC_BASE is unset', () => {
    const env: CatalogEnv = { MOCK_R2: 'true', CATALOG_R2_BUCKET: 'tv' }
    expect(resolveR2PublicUrl(env, KEY)).toBe(`https://mock-r2.localhost/tv/${KEY}`)
  })

  it('defaults bucket to `terraviz-assets` when CATALOG_R2_BUCKET is unset', () => {
    const env: CatalogEnv = { MOCK_R2: 'true' }
    expect(resolveR2PublicUrl(env, KEY)).toBe(`https://mock-r2.localhost/terraviz-assets/${KEY}`)
  })

  it('falls through to R2_S3_ENDPOINT when neither public base nor MOCK_R2 is set', () => {
    const env: CatalogEnv = {
      R2_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com/',
      CATALOG_R2_BUCKET: 'terraviz-assets',
    }
    expect(resolveR2PublicUrl(env, KEY)).toBe(
      `https://acct.r2.cloudflarestorage.com/terraviz-assets/${KEY}`,
    )
  })

  it('returns null when nothing is configured', () => {
    expect(resolveR2PublicUrl({}, KEY)).toBeNull()
  })

  it('encodes special chars in path segments but preserves slashes', () => {
    const env: CatalogEnv = { MOCK_R2: 'true', CATALOG_R2_BUCKET: 'tv' }
    // `encodeURIComponent` leaves `()` alone (unreserved per RFC 3986),
    // which is fine for an R2 read URL — the bucket accepts them
    // verbatim. The important behaviour is encoding spaces and
    // preserving slashes as path separators.
    const url = resolveR2PublicUrl(env, 'datasets/has space/file (1).png')!
    expect(url).toContain('/has%20space/')
    expect(url).toContain('/file%20(1).png')
    expect(url.split('/').length).toBeGreaterThan(3)
  })
})

describe('resolveAssetRef', () => {
  const env: CatalogEnv = { MOCK_R2: 'true', CATALOG_R2_BUCKET: 'tv' }

  it('strips r2: scheme and dispatches to resolveR2PublicUrl', () => {
    expect(resolveAssetRef(env, 'r2:datasets/DS001/sphere-thumbnail.jpg')).toBe(
      'https://mock-r2.localhost/tv/datasets/DS001/sphere-thumbnail.jpg',
    )
  })

  it('passes bare URLs through', () => {
    expect(resolveAssetRef(env, 'https://example.com/img.png')).toBe(
      'https://example.com/img.png',
    )
  })

  it('returns null for null / undefined / empty', () => {
    expect(resolveAssetRef(env, null)).toBeNull()
    expect(resolveAssetRef(env, undefined)).toBeNull()
    expect(resolveAssetRef(env, '')).toBeNull()
  })
})

describe('resolveR2HlsPublicUrl', () => {
  // The HLS branch of the manifest endpoint uses this stricter
  // resolver instead of `resolveR2PublicUrl` so that a typical
  // production setup (R2_S3_ENDPOINT set for signing PUTs, but
  // bucket NOT publicly readable through that endpoint) surfaces
  // as `r2_unconfigured` rather than handing the client a URL
  // that 403s at HLS play time.
  const KEY = 'videos/DS001/master.m3u8'

  it('uses R2_PUBLIC_BASE when set', () => {
    const env: CatalogEnv = {
      R2_PUBLIC_BASE: 'https://video.example.com',
      CATALOG_R2_BUCKET: 'terraviz-assets',
    }
    expect(resolveR2HlsPublicUrl(env, KEY)).toBe(`https://video.example.com/${KEY}`)
  })

  it('falls through to MOCK_R2 host when R2_PUBLIC_BASE is unset', () => {
    const env: CatalogEnv = { MOCK_R2: 'true', CATALOG_R2_BUCKET: 'tv' }
    expect(resolveR2HlsPublicUrl(env, KEY)).toBe(`https://mock-r2.localhost/tv/${KEY}`)
  })

  it('returns null when only R2_S3_ENDPOINT is configured', () => {
    // The whole point of the stricter resolver: the S3-endpoint
    // fallback that `resolveR2PublicUrl` performs is intentionally
    // skipped here because that URL pattern doesn't produce a
    // publicly-readable origin for HLS in a typical production
    // deployment.
    const env: CatalogEnv = {
      R2_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
      CATALOG_R2_BUCKET: 'terraviz-assets',
    }
    expect(resolveR2HlsPublicUrl(env, KEY)).toBeNull()
  })

  it('returns null when nothing is configured', () => {
    expect(resolveR2HlsPublicUrl({}, KEY)).toBeNull()
  })

  it('strips trailing slash from R2_PUBLIC_BASE', () => {
    const env: CatalogEnv = { R2_PUBLIC_BASE: 'https://video.example.com/' }
    expect(resolveR2HlsPublicUrl(env, KEY)).toBe(`https://video.example.com/${KEY}`)
  })
})

describe('resolveAssetRefStrict (3b/O)', () => {
  // The serializer's dataset GET path uses this stricter resolver
  // so a missing R2_PUBLIC_BASE produces a missing-field omission
  // rather than a URL that 403s in the browser. Same no-fallback
  // policy as the manifest endpoint's HLS branch.

  it('resolves r2: refs via R2_PUBLIC_BASE when set', () => {
    const env: CatalogEnv = { R2_PUBLIC_BASE: 'https://assets.example.com' }
    expect(
      resolveAssetRefStrict(env, 'r2:datasets/DS001/thumbnail.jpg'),
    ).toBe('https://assets.example.com/datasets/DS001/thumbnail.jpg')
  })

  it('falls through to MOCK_R2 host when R2_PUBLIC_BASE is unset', () => {
    const env: CatalogEnv = { MOCK_R2: 'true', CATALOG_R2_BUCKET: 'tv' }
    expect(
      resolveAssetRefStrict(env, 'r2:datasets/DS001/thumbnail.jpg'),
    ).toBe('https://mock-r2.localhost/tv/datasets/DS001/thumbnail.jpg')
  })

  it('returns null for an r2: ref when only R2_S3_ENDPOINT is set (no public-bucket fallback)', () => {
    // This is the whole point of the strict resolver: production
    // typically has R2_S3_ENDPOINT bound for signed PUTs (CLI use)
    // but the bucket is NOT publicly readable through that endpoint.
    // The lenient resolveAssetRef would emit an S3-endpoint URL
    // here; the strict variant omits it so the caller can drop
    // the field from the wire entirely.
    const env: CatalogEnv = {
      R2_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
      CATALOG_R2_BUCKET: 'terraviz-assets',
    }
    expect(resolveAssetRefStrict(env, 'r2:datasets/DS001/thumbnail.jpg')).toBeNull()
  })

  it('passes bare https URLs through unchanged (pre-migration rows)', () => {
    const env: CatalogEnv = {}
    expect(
      resolveAssetRefStrict(env, 'https://d3sik7mbbzunjo.cloudfront.net/x/thumb.jpg'),
    ).toBe('https://d3sik7mbbzunjo.cloudfront.net/x/thumb.jpg')
  })

  it('returns null for empty / null / undefined inputs', () => {
    const env: CatalogEnv = { R2_PUBLIC_BASE: 'https://assets.example.com' }
    expect(resolveAssetRefStrict(env, null)).toBeNull()
    expect(resolveAssetRefStrict(env, undefined)).toBeNull()
    expect(resolveAssetRefStrict(env, '')).toBeNull()
  })
})

describe('encodeR2Key', () => {
  it('encodes special chars but preserves slashes', () => {
    expect(encodeR2Key('a/b c/d?e')).toBe('a/b%20c/d%3Fe')
  })
})

describe('buildFrameRecallUrl (content-addressed)', () => {
  const DS = '01HXAAAAAAAAAAAAAAAAAAAAAA'
  const HEX = 'a'.repeat(64)
  const DIGEST = `sha256:${HEX}`
  const PUBLIC_BASE = 'https://assets.terraviz.example.com'

  it('resolves a frame to its content-addressed public URL', () => {
    const env = { R2_PUBLIC_BASE: PUBLIC_BASE } as CatalogEnv
    expect(buildFrameRecallUrl(env, DS, DIGEST, 'png')).toBe(
      `${PUBLIC_BASE}/videos/${DS}/frames/sha256/${HEX}.png`,
    )
  })

  it('falls through MOCK_R2 when R2_PUBLIC_BASE is unset', () => {
    const env = { MOCK_R2: 'true', CATALOG_R2_BUCKET: 'bkt' } as CatalogEnv
    expect(buildFrameRecallUrl(env, DS, DIGEST, 'webp')).toBe(
      `https://mock-r2.localhost/bkt/videos/${DS}/frames/sha256/${HEX}.webp`,
    )
  })

  it('returns null when no public base is configured', () => {
    expect(buildFrameRecallUrl({} as CatalogEnv, DS, DIGEST, 'png')).toBeNull()
  })

  it('fails quiet (null, not throw) on a malformed digest, dataset, or extension', () => {
    const env = { R2_PUBLIC_BASE: PUBLIC_BASE } as CatalogEnv
    expect(buildFrameRecallUrl(env, DS, 'sha256:nothex', 'png')).toBeNull()
    expect(buildFrameRecallUrl(env, 'NOTAULID', DIGEST, 'png')).toBeNull()
    expect(buildFrameRecallUrl(env, DS, DIGEST, 'PNG')).toBeNull()
    expect(buildFrameRecallUrl(env, DS, DIGEST, '../etc/passwd')).toBeNull()
  })
})

describe('buildFramesRedirectTemplate (dataset-level urlTemplate)', () => {
  const DS = '01HXAAAAAAAAAAAAAAAAAAAAAA'
  const BASE = 'https://node.terraviz.example.com'

  it('points the {index} template at the /frames/{index} redirect endpoint', () => {
    const env = { R2_PUBLIC_BASE: 'https://assets.example' } as CatalogEnv
    expect(buildFramesRedirectTemplate(env, BASE, DS)).toBe(
      `${BASE}/api/v1/datasets/${DS}/frames/{index}`,
    )
  })

  it('keeps the {index} braces literal so consumers substitute directly', () => {
    const env = { MOCK_R2: 'true' } as CatalogEnv
    const t = buildFramesRedirectTemplate(env, `${BASE}/`, DS)!
    expect(t).toContain('{index}')
    expect(t).not.toContain('%7B')
    // Trailing slash on baseUrl is normalised.
    expect(t).toBe(`${BASE}/api/v1/datasets/${DS}/frames/{index}`)
  })

  it('returns null when R2 public origin is unconfigured (frames not advertised)', () => {
    expect(buildFramesRedirectTemplate({} as CatalogEnv, BASE, DS)).toBeNull()
  })

  it('returns null for a non-ULID dataset id', () => {
    const env = { MOCK_R2: 'true' } as CatalogEnv
    expect(buildFramesRedirectTemplate(env, BASE, 'NOTAULID')).toBeNull()
  })
})

describe('resolveHttpAssetUrl (PR #208 — portal fetch/img safety)', () => {
  it('resolves an r2: ref to its http(s) public URL', () => {
    const env: CatalogEnv = { R2_PUBLIC_BASE: 'https://assets.example.com' }
    expect(resolveHttpAssetUrl(env, 'r2:datasets/DS/thumbnail.webp')).toBe(
      'https://assets.example.com/datasets/DS/thumbnail.webp',
    )
  })

  it('passes a bare https URL through', () => {
    const env: CatalogEnv = {}
    expect(resolveHttpAssetUrl(env, 'https://cdn.example/x.png')).toBe(
      'https://cdn.example/x.png',
    )
  })

  it('returns null for a non-http(s) ref (vimeo:) so the portal never fetches it', () => {
    const env: CatalogEnv = { R2_PUBLIC_BASE: 'https://assets.example.com' }
    expect(resolveHttpAssetUrl(env, 'vimeo:123456')).toBeNull()
  })

  it('returns null for an r2: ref that cannot be resolved (no public base)', () => {
    const env: CatalogEnv = {}
    expect(resolveHttpAssetUrl(env, 'r2:datasets/DS/thumbnail.webp')).toBeNull()
  })

  it('returns null for empty / nullish refs', () => {
    const env: CatalogEnv = { R2_PUBLIC_BASE: 'https://assets.example.com' }
    expect(resolveHttpAssetUrl(env, null)).toBeNull()
    expect(resolveHttpAssetUrl(env, '')).toBeNull()
  })
})
