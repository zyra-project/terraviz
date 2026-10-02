// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, describe, expect, it, vi } from 'vitest'
import { auditStac } from './audit-stac'
import { stacRouteFixture } from '../functions/api/v1/_lib/stac-test-helpers'
import { makeCtx } from '../functions/api/v1/_lib/test-helpers'
import { onRequestGet } from '../functions/api/v1/stac/[[path]]'
import { onRequestGet as manifestGet } from '../functions/api/v1/datasets/[id]/manifest'
import schema from '../docs/metadata/schemas/terraviz-v1.0.0.json'

describe('STAC traversal and reachability audit', () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each([{ count: 3, failNext: false }, { count: 51, failNext: false }, { count: 51, failNext: true }])('audits real root-discovered listings and next pages: %j', async ({ count, failNext }) => {
    const { sqlite, env } = stacRouteFixture(count)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'Content-Type': 'image/png' } })))
    try {
      const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(String(input))
        if (failNext && url.searchParams.has('cursor')) return new Response(null, { status: 503 })
        if (url.pathname.startsWith('/api/v1/stac')) return onRequestGet(makeCtx({ env, url: url.href }) as never)
        if (url.pathname.endsWith('/manifest')) {
          const response = await manifestGet(makeCtx({ env, url: url.href, params: { id: url.pathname.split('/')[4] } }) as never)
          return init?.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response
        }
        if (url.href === schema.$id) return Response.json(schema)
        if (url.origin === 'https://data.example') return new Response(null, { headers: { 'Content-Type': 'image/png' } })
        throw new Error('Unexpected URL')
      })
      const report = await auditStac({ root: 'https://node.example/api/v1/stac', allowedOrigins: ['https://data.example', new URL(schema.$id).origin], fetchImpl })
      expect(report.ok).toBe(!failNext)
      if (failNext) expect(report.issues).toEqual([
        expect.objectContaining({ code: 'document_http_503' }), expect.objectContaining({ code: 'document_http_503' }),
      ])
      else expect(report).toMatchObject({ documents: 1 + count * 3 + 2 + (count > 50 ? 2 : 0), assets: count + 1, schemas: 1, issues: [] })
      const urls = fetchImpl.mock.calls.map(([input]) => new URL(String(input)))
      expect(urls.some(url => url.pathname === '/api/v1/stac/collections')).toBe(true)
      expect(urls.some(url => url.pathname === '/api/v1/stac/items')).toBe(true)
      expect(new Set(urls.filter(url => /\/collections\/[^/]+\/items$/.test(url.pathname)).map(url => url.pathname)).size).toBe(count)
      if (count > 50) expect(urls.filter(url => url.searchParams.has('cursor')).map(url => url.pathname).sort())
        .toEqual(['/api/v1/stac/collections', '/api/v1/stac/items'])
      expect(fetchImpl.mock.calls.every(([, init]) => init?.credentials === 'omit' && init.redirect === 'manual')).toBe(true)
    } finally { sqlite.close() }
  })

  const root = 'https://node.example/api/v1/stac'
  const catalog = (links: unknown[] = [], extra: Record<string, unknown> = {}) => ({ type: 'Catalog', stac_version: '1.1.0', id: 'node',
    description: 'Node', links: [{ rel: 'self', href: root, type: 'application/json' }, ...links], ...extra })

  it('follows next pages once and terminates cycles', async () => {
    const next = `${root}/items?cursor=one`
    const fetchImpl = vi.fn<typeof fetch>(async input => Response.json(String(input) === root
      ? catalog([{ rel: 'next', href: next, type: 'application/json' }]) : catalog([{ rel: 'next', href: root }])))
    const report = await auditStac({ root, fetchImpl })
    expect(report.ok).toBe(true)
    expect(report.documents).toBe(2)
  })

  it.each([401, 403, 404, 302])('fails the audit for asset HTTP %s', async status => {
    const fetchImpl = vi.fn<typeof fetch>(async input => String(input) === root
      ? Response.json(catalog([], { assets: { data: { href: 'https://data.example/image.png', type: 'image/png' } } }))
      : new Response(null, { status }))
    const report = await auditStac({ root, fetchImpl, allowedOrigins: ['https://data.example'] })
    expect(report.ok).toBe(false)
    expect(report.issues).toContainEqual({ url: 'https://data.example/image.png', code: `asset_http_${status}` })
  })

  it('refuses untrusted links without fetching them', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(catalog([{ rel: 'child', href: 'https://untrusted.example/catalog' }])))
    const report = await auditStac({ root, fetchImpl })
    expect(report.ok).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('requires explicit upstream-origin trust on a fork (configured=%s)', async configured => {
    const upstream = new URL(schema.$id).origin
    const asset = `${upstream}/image.png`
    const fetchImpl = vi.fn<typeof fetch>(async input => String(input) === root
      ? Response.json(catalog([{ rel: 'related', href: asset, type: 'image/png' }], {
        stac_extensions: [schema.$id], assets: { data: { href: asset, type: 'image/png' } },
      })) : String(input) === schema.$id ? Response.json(schema)
        : new Response(null, { headers: { 'Content-Type': 'image/png' } }))
    const report = await auditStac({ root, fetchImpl, allowedOrigins: configured ? [upstream] : [] })
    expect(report.ok).toBe(configured)
    expect(fetchImpl).toHaveBeenCalledTimes(configured ? 3 : 1)
    if (!configured) expect(report.issues.map(issue => issue.code)).toEqual([
      'invalid_or_untrusted_link', 'unsafe_or_untrusted_asset', 'invalid_or_untrusted_schema',
    ])
  })

  it('reports wrong media types and missing schema identities', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async input => String(input) === root
      ? Response.json(catalog([], { stac_extensions: [schema.$id], assets: { data: { href: `${root}/image`, type: 'image/png' } } }))
      : String(input) === schema.$id ? Response.json({}) : new Response(null, { headers: { 'Content-Type': 'text/html' } }))
    const report = await auditStac({ root, fetchImpl, allowedOrigins: [new URL(schema.$id).origin] })
    expect(report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['schema_identity', 'terraviz_schema_drift', 'asset_media_type']))
  })

  it('fails rather than silently truncating traversal at its document budget', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(catalog([{ rel: 'child', href: `${root}/collections/one` }])))
    const report = await auditStac({ root, fetchImpl, maxDocuments: 1 })
    expect(report.ok).toBe(false)
    expect(report.issues).toContainEqual({ url: root, code: 'document_limit' })
  })
})