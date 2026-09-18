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

  it('traverses real route output, native manifests and declared schemas without live network', async () => {
    const { sqlite, env } = stacRouteFixture(3)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'Content-Type': 'image/png' } })))
    try {
      const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(String(input))
        if (url.pathname.startsWith('/api/v1/stac')) return onRequestGet(makeCtx({ env, url: url.href }) as never)
        if (url.pathname.endsWith('/manifest')) {
          const response = await manifestGet(makeCtx({ env, url: url.href, params: { id: url.pathname.split('/')[4] } }) as never)
          return init?.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response
        }
        if (url.href === schema.$id) return Response.json(schema)
        if (url.origin === 'https://data.example') return new Response(null, { headers: { 'Content-Type': 'image/png' } })
        throw new Error('Unexpected URL')
      })
      const report = await auditStac({ root: 'https://node.example/api/v1/stac', allowedOrigins: ['https://data.example'], fetchImpl })
      expect(report).toMatchObject({ ok: true, documents: 7, assets: 4, schemas: 1, issues: [] })
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

  it('reports wrong media types and missing schema identities', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async input => String(input) === root
      ? Response.json(catalog([], { stac_extensions: [schema.$id], assets: { data: { href: `${root}/image`, type: 'image/png' } } }))
      : String(input) === schema.$id ? Response.json({}) : new Response(null, { headers: { 'Content-Type': 'text/html' } }))
    const report = await auditStac({ root, fetchImpl })
    expect(report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['schema_identity', 'terraviz_schema_drift', 'asset_media_type']))
  })

  it('fails rather than silently truncating traversal at its document budget', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(catalog([{ rel: 'child', href: `${root}/collections/one` }])))
    const report = await auditStac({ root, fetchImpl, maxDocuments: 1 })
    expect(report.ok).toBe(false)
    expect(report.issues).toContainEqual({ url: root, code: 'document_limit' })
  })
})