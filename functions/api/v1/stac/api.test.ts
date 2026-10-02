// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestGet } from './[[path]]'
import { makeCtx } from '../_lib/test-helpers'
import { stacRouteFixture } from '../_lib/stac-test-helpers'
import { readStacPublication } from '../_lib/stac-publication'
import type { StacItem, StacLink } from '../_lib/stac-types'

describe('STAC API Features', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'Content-Type': 'image/png' } }))))
  afterEach(() => vi.unstubAllGlobals())

  it('discovers conformance and service resources with matching media types', async () => {
    const { sqlite, env } = stacRouteFixture()
    try {
      const root = await (await onRequestGet(makeCtx({ env, url: 'https://node.example/api/v1/stac' }) as never)).json() as { conformsTo: string[]; links: StacLink[] }
      expect(root.conformsTo).toContain('https://api.stacspec.org/v1.0.0/core')
      for (const rel of ['conformance', 'service-desc', 'service-doc']) {
        const link = root.links.find(value => value.rel === rel)!
        const response = await onRequestGet(makeCtx({ env, url: link.href, headers: { Accept: link.type! } }) as never)
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain(link.type)
        if (rel === 'conformance') expect(await response.json()).toEqual({ conformsTo: root.conformsTo })
        if (rel === 'service-desc') {
          const api = await response.json() as { openapi: string; servers: { url: string }[]; paths: Record<string, unknown> }
          expect(api.openapi).toBe('3.0.3')
          expect(api.servers[0].url).toBe('https://node.example/api/v1/stac')
          expect(api.paths['/collections/{collectionId}/items']).toBeTruthy()
        }
      }
    } finally { sqlite.close() }
  })

  it('filters before pagination and retains filters in canonical links', async () => {
    const { sqlite, env } = stacRouteFixture(3)
    try {
      const response = await onRequestGet(makeCtx({ env, url: 'https://spoof.example/api/v1/stac/items?bbox=-180,-90,180,90&datetime=../2099-01-01T00:00:00Z&limit=1' }) as never)
      expect(response.status).toBe(200)
      const page = await response.json() as { features: StacItem[]; links: StacLink[]; numberMatched: number; numberReturned: number }
      expect(page.numberMatched).toBe(3)
      expect(page.numberReturned).toBe(1)
      const next = page.links.find(link => link.rel === 'next')!
      expect(new URL(next.href).hostname).toBe('node.example')
      expect(new URL(next.href).searchParams.get('bbox')).toBe('-180,-90,180,90')
      expect(new URL(next.href).searchParams.get('datetime')).toBe('../2099-01-01T00:00:00Z')
      const second = await (await onRequestGet(makeCtx({ env, url: next.href }) as never)).json() as typeof page
      expect(second.features[0].id).not.toBe(page.features[0].id)
      const empty = await (await onRequestGet(makeCtx({ env, url: 'https://node.example/api/v1/stac/items?datetime=1900-01-01T00:00:00Z' }) as never)).json() as typeof page
      expect(empty.features).toEqual([])
    } finally { sqlite.close() }
  })

  it('links a collection-items response to its collection and clamps excessive limits', async () => {
    const { sqlite, env } = stacRouteFixture()
    try {
      const publication = await readStacPublication(env)
      const collection = publication.products[0].collection!
      const url = `https://node.example/api/v1/stac/collections/${collection.id}/items?limit=1000`
      const response = await onRequestGet(makeCtx({ env, url }) as never)
      expect(response.status).toBe(200)
      const page = await response.json() as { links: StacLink[] }
      expect(page.links).toContainEqual({ rel: 'collection', href: `https://node.example/api/v1/stac/collections/${collection.id}`, type: 'application/json' })
      expect(new URL(page.links.find(link => link.rel === 'self')!.href).searchParams.get('limit')).toBe('1000')
    } finally { sqlite.close() }
  })

  it('supports HEAD, rejects unsupported media and rejects writes', async () => {
    const { sqlite, env } = stacRouteFixture()
    try {
      const url = 'https://node.example/api/v1/stac/items'
      const head = await onRequestGet(makeCtx({ env, url, method: 'HEAD' }) as never)
      expect(head.status).toBe(200)
      expect(await head.text()).toBe('')
      expect(head.headers.get('etag')).toBeTruthy()
      expect((await onRequestGet(makeCtx({ env, url, headers: { Accept: 'text/html' } }) as never)).status).toBe(406)
      const post = await onRequestGet(makeCtx({ env, url, method: 'POST' }) as never)
      expect(post.status).toBe(405)
      expect(post.headers.get('allow')).toContain('GET')
    } finally { sqlite.close() }
  })
})