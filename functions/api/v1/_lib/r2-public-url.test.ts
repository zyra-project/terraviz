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
  buildFramesUrlTemplate,
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

describe('buildFramesUrlTemplate (3pg/A)', () => {
  const DS = '01HXAAAAAAAAAAAAAAAAAAAAAA'
  const UP = '01HYAAAAAAAAAAAAAAAAAAAAAA'
  const REF = `r2:uploads/${DS}/${UP}/source_filenames.json`
  const PUBLIC_BASE = 'https://assets.terraviz.example.com'

  it('builds a public URL template with a literal {index} token', () => {
    const env = { R2_PUBLIC_BASE: PUBLIC_BASE } as CatalogEnv
    const template = buildFramesUrlTemplate(env, REF, 'png')
    expect(template).toBe(
      `${PUBLIC_BASE}/uploads/${DS}/${UP}/frames/{index}.png`,
    )
  })

  it('preserves the {index} braces literally (no URL encoding)', () => {
    // `encodeURIComponent('{')` is `%7B` — the whole point of the
    // sentinel-and-swap pattern is that consumers can do
    // `template.replace('{index}', padded)` without URL-decoding.
    const env = { R2_PUBLIC_BASE: PUBLIC_BASE } as CatalogEnv
    const template = buildFramesUrlTemplate(env, REF, 'jpg')!
    expect(template).toContain('{index}')
    expect(template).not.toContain('%7B')
    expect(template).not.toContain('%7D')
  })

  it('falls through MOCK_R2 when R2_PUBLIC_BASE is unset', () => {
    const env = { MOCK_R2: 'true', CATALOG_R2_BUCKET: 'bkt' } as CatalogEnv
    const template = buildFramesUrlTemplate(env, REF, 'webp')
    expect(template).toBe(
      `https://mock-r2.localhost/bkt/uploads/${DS}/${UP}/frames/{index}.webp`,
    )
  })

  it('returns null when neither R2_PUBLIC_BASE nor MOCK_R2 is set', () => {
    // Mirrors the resolveR2HlsPublicUrl policy — a missing public
    // base surfaces as a wire-field omission rather than a URL that
    // 403s on the SPA. The strict variant is what catches the
    // misconfig before publishing the wire shape.
    const env = {} as CatalogEnv
    expect(buildFramesUrlTemplate(env, REF, 'png')).toBeNull()
  })

  it('returns null when the source-filenames ref shape is wrong', () => {
    const env = { R2_PUBLIC_BASE: PUBLIC_BASE } as CatalogEnv
    // Missing `r2:` scheme.
    expect(
      buildFramesUrlTemplate(env, `uploads/${DS}/${UP}/source_filenames.json`, 'png'),
    ).toBeNull()
    // Wrong filename.
    expect(
      buildFramesUrlTemplate(env, `r2:uploads/${DS}/${UP}/index.json`, 'png'),
    ).toBeNull()
    // Non-ULID dataset id.
    expect(
      buildFramesUrlTemplate(env, `r2:uploads/short/${UP}/source_filenames.json`, 'png'),
    ).toBeNull()
    // Non-ULID upload id.
    expect(
      buildFramesUrlTemplate(env, `r2:uploads/${DS}/short/source_filenames.json`, 'png'),
    ).toBeNull()
  })

  it('rejects extensions outside the [a-z0-9]+ allowlist', () => {
    const env = { R2_PUBLIC_BASE: PUBLIC_BASE } as CatalogEnv
    // Empty.
    expect(buildFramesUrlTemplate(env, REF, '')).toBeNull()
    // Uppercase or path traversal would otherwise produce a URL
    // that lands at the wrong R2 key.
    expect(buildFramesUrlTemplate(env, REF, 'PNG')).toBeNull()
    expect(buildFramesUrlTemplate(env, REF, '../etc/passwd')).toBeNull()
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
