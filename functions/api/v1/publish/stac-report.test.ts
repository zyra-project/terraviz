// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestGet } from './stac-report'
import { stacRouteFixture } from '../_lib/stac-test-helpers'
import { makeCtx } from '../_lib/test-helpers'

describe('operator STAC report', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'Content-Type': 'image/png' } }))))
  afterEach(() => vi.unstubAllGlobals())

  it.each([undefined, { role: 'publisher', status: 'active', is_admin: 0 },
    { role: 'admin', status: 'suspended', is_admin: 1 }])('rejects unauthorized callers before reading D1: %j', async publisher => {
    const context = makeCtx({ env: {} })
    context.data = publisher ? { publisher } : {}
    const response = await onRequestGet(context as never)
    expect(response.status).toBe(publisher ? 403 : 401)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
  })

  it('reports private and ineligible records while publication is disabled, without caching or probing private URLs', async () => {
    const { sqlite, ids, env } = stacRouteFixture(3)
    try {
      env.STAC_ENABLED = 'false'
      sqlite.prepare("UPDATE datasets SET visibility='private', data_ref='url:https://private.example/secret.png' WHERE id=?").run(ids[1])
      sqlite.prepare("UPDATE datasets SET bbox_n=bbox_s WHERE id=?").run(ids[2])
      const context = makeCtx({ env, url: 'https://node.example/api/v1/publish/stac-report' })
      context.data = { publisher: { role: 'admin', is_admin: 1, status: 'active' } }
      const response = await onRequestGet(context as never)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ schema_version: 1, publication_enabled: false,
        totals: { evaluated: 3, included: 1, excluded: 2 }, records: [
          { id: ids[0], included: true }, { id: ids[1], included: false, reasons: ['not_public'] },
          { id: ids[2], included: false, reasons: expect.arrayContaining(['spatial_bounds_degenerate']) },
        ] })
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(env.CATALOG_KV.put).not.toHaveBeenCalled()
      expect(env.CATALOG_KV.get).not.toHaveBeenCalled()
    } finally { sqlite.close() }
  })

  it('reports a concrete asset verification failure without exposing the source URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 403 })))
    const { sqlite, env } = stacRouteFixture()
    try {
      const context = makeCtx({ env })
      context.data = { publisher: { role: 'service', is_admin: 0, status: 'active' } }
      const response = await onRequestGet(context as never)
      const text = await response.text()
      expect(text).toContain('asset_http_403')
      expect(text).not.toContain('https://data.example')
    } finally { sqlite.close() }
  })
})