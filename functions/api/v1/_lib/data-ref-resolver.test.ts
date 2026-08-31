// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the data-ref → public-URL resolver used by the catalog
 * read path to surface `tourJsonUrl` on tour rows.
 *
 * The schemes that need to resolve to a directly-fetchable file:
 *   - `url:<href>`  → unwrapped href (SOS-seeded tours)
 *   - `r2:<key>`    → public R2 URL (publisher-uploaded tours)
 *
 * Anything else (`vimeo:`, `stream:`, `peer:`, malformed) returns
 * null. The catalog serializer treats null as "leave tourJsonUrl
 * unset" — older clients then fall back to `dataLink`.
 */

import { describe, expect, it } from 'vitest'
import { makeDataRefResolver } from './data-ref-resolver'
import type { CatalogEnv } from './env'

function fakeEnv(overrides: Partial<CatalogEnv> = {}): CatalogEnv {
  return {
    R2_PUBLIC_BASE: 'https://assets.example.com',
    CATALOG_R2_BUCKET: 'terraviz-assets',
    ...overrides,
  } as CatalogEnv
}

describe('makeDataRefResolver', () => {
  it('unwraps url:<href> references to the bare href', () => {
    const resolve = makeDataRefResolver(fakeEnv())
    expect(
      resolve('url:https://d3sik7mbbzunjo.cloudfront.net/extras/pandemic_story/tour.json'),
    ).toBe(
      'https://d3sik7mbbzunjo.cloudfront.net/extras/pandemic_story/tour.json',
    )
  })

  it('preserves the full URL when the href contains a colon (e.g. ports, fragments)', () => {
    // Colon-after-scheme is the only delimiter parseDataRef splits
    // on; anything in the value is opaque. Locks in that
    // url:https://… URLs work even when the URL has additional
    // colons further along (port numbers, IPv6, etc.).
    const resolve = makeDataRefResolver(fakeEnv())
    expect(resolve('url:https://example.com:8443/tour.json')).toBe(
      'https://example.com:8443/tour.json',
    )
  })

  it('resolves r2:<key> via the configured R2_PUBLIC_BASE', () => {
    const resolve = makeDataRefResolver(fakeEnv())
    expect(resolve('r2:tours/sample.json')).toBe(
      'https://assets.example.com/tours/sample.json',
    )
  })

  it('percent-encodes path segments inside an r2: key', () => {
    const resolve = makeDataRefResolver(fakeEnv())
    expect(resolve('r2:tours/needs encoding.json')).toBe(
      'https://assets.example.com/tours/needs%20encoding.json',
    )
  })

  it('returns null for non-fetchable schemes', () => {
    const resolve = makeDataRefResolver(fakeEnv())
    // These all resolve to non-file targets — vimeo and stream
    // are video manifests handled by the manifest endpoint, peer
    // is federation indirection. None should ever land on a tour
    // row, but the resolver should be defensive about it rather
    // than throwing.
    expect(resolve('vimeo:123456')).toBeNull()
    expect(resolve('stream:abc-def')).toBeNull()
    expect(resolve('peer:other-node/dataset')).toBeNull()
  })

  it('returns null for a malformed data_ref', () => {
    const resolve = makeDataRefResolver(fakeEnv())
    expect(resolve('')).toBeNull()
    expect(resolve('no-colon')).toBeNull()
    expect(resolve(':leading-colon')).toBeNull()
  })

  it('returns null for r2:<key> when no public base is configured', () => {
    // resolveR2PublicUrl returns null when neither R2_PUBLIC_BASE
    // nor MOCK_R2 nor R2_S3_ENDPOINT is set; the resolver passes
    // that through.
    const resolve = makeDataRefResolver(
      fakeEnv({ R2_PUBLIC_BASE: undefined, CATALOG_R2_BUCKET: undefined }),
    )
    expect(resolve('r2:tours/sample.json')).toBeNull()
  })
})
