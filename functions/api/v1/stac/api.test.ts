// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequest, onRequestGet, onRequestOptions } from './[[path]]'
import * as queryModule from '../_lib/stac-query'
import Ajv from 'ajv'
import { stacOpenApi } from '../_lib/stac-service'
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
        if (rel === 'service-doc') {
          const html = await response.text()
          expect(html).toContain('/search')
          expect(html).toContain('intersects')
          expect(html).toContain('POST application/json')
        }
      }
    } finally { sqlite.close() }
  })

  it('documents exact request limits, opaque cursors and method-specific exceptions', () => {
    const api = stacOpenApi('https://node.example/api/v1/stac')
    const search = api.paths['/search']
    expect(search.get.responses).toHaveProperty('304')
    expect(search.post.responses).not.toHaveProperty('304')
    expect(search.post.responses).toHaveProperty('413')
    expect(search.post.responses).toHaveProperty('415')
    const properties = search.post.requestBody.content['application/json'].schema.properties
    const ajv = new Ajv({ strict: false })
    const bbox = ajv.compile(properties.bbox)
    expect(bbox([0, 0, 1, 1])).toBe(true)
    expect(bbox([0, 0, 0, 1, 1, 1])).toBe(true)
    expect(bbox([0, 0, 0, 1, 1])).toBe(false)
    const ids = ajv.compile(properties.ids)
    expect(ids(['a'.repeat(256)])).toBe(true)
    expect(ids(['a'.repeat(257)])).toBe(false)
    expect(ids(Array(101).fill('id'))).toBe(false)
    expect(ids([])).toBe(false)
    expect(properties.ids.description).toContain('Nonempty')
    const cursor = ajv.compile(properties.cursor)
    expect(cursor('a'.repeat(256))).toBe(true)
    expect(cursor('a'.repeat(257))).toBe(false)
    expect(cursor('')).toBe(false)
    expect(ajv.compile(properties.limit)(1000)).toBe(true)
    expect(properties.cursor.description).toBe('Opaque. Use only values from next links.')
    expect(search.get.parameters).toContainEqual(expect.objectContaining({ name: 'cursor', description: properties.cursor.description }))
    expect(api.components.schemas.Link.properties).toHaveProperty('method')
    expect(api.components.schemas.Link.properties).toHaveProperty('body')
    expect(search.post.responses['400']).toMatchObject({ content: { 'application/json': { schema: { $ref: '#/components/schemas/Exception' } } } })
    for (const schema of Object.values(api.components.schemas)) {
      const defined = 'properties' in schema ? schema.properties : {}
      if ('required' in schema) expect(schema.required.every(key => key in defined)).toBe(true)
    }
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

  it.each(['PUT', 'PATCH', 'DELETE'])('routes unsupported %s through the real Pages catch-all', async method => {
    const { sqlite, env } = stacRouteFixture()
    try {
      const response = await onRequest(makeCtx({ env, url: 'https://node.example/api/v1/stac/search', method }) as never)
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe('GET, HEAD, POST, OPTIONS')
      expect(await response.json()).toMatchObject({ error: 'method_not_allowed', code: 'method_not_allowed', description: expect.any(String) })
      expect(fetch).not.toHaveBeenCalled()
    } finally { sqlite.close() }
  })

  it('contains runtime intersection rejections without false publication-failure logs', async () => {
    const { sqlite, env } = stacRouteFixture()
    const matcher = vi.spyOn(queryModule, 'matchesStacQuery').mockImplementationOnce(() => { throw new Error('invalid_intersects') })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const response = await onRequest(makeCtx({ env, url: 'https://node.example/api/v1/stac/search?intersects=' + encodeURIComponent('{"type":"Point","coordinates":[0,0]}') }) as never)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: 'invalid_intersects', code: 'invalid_intersects' })
      expect(log).not.toHaveBeenCalled()
    } finally { matcher.mockRestore(); log.mockRestore(); sqlite.close() }
  })

  it('uses only known query error codes for unexpected parser failures', async () => {
    const { sqlite, env } = stacRouteFixture()
    const parser = vi.spyOn(queryModule, 'parseStacQuery').mockImplementationOnce(() => { throw new Error('private parser diagnostics') })
    try {
      const response = await onRequest(makeCtx({ env, url: 'https://node.example/api/v1/stac/search' }) as never)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: 'invalid_query', code: 'invalid_query' })
      expect(fetch).not.toHaveBeenCalled()
    } finally { parser.mockRestore(); sqlite.close() }
  })

  it('keeps canonical Item identity independent of traversal', async () => {
    const { sqlite, ids, env } = stacRouteFixture()
    const root = 'https://node.example/api/v1/stac'
    const canonical = `${root}/items/${ids[0]}`
    try {
      for (const path of ['search', `collections/NODE000-${ids[0]}/items`, `items/${ids[0]}`, `collections/NODE000-${ids[0]}/items/${ids[0]}`]) {
        const response = await onRequest(makeCtx({ env, url: `${root}/${path}` }) as never)
        expect(response.status).toBe(200)
        const document = await response.json() as StacItem & { features?: StacItem[] }
        const item = document.features?.[0] ?? document
        expect((item.links.find(link => link.rel === 'canonical') ?? item.links.find(link => link.rel === 'self'))?.href).toBe(canonical)
      }
    } finally { sqlite.close() }
  })

  it('limits conditional 304 responses to GET/HEAD and never caches POST search', async () => {
    const { sqlite, env } = stacRouteFixture()
    const url = 'https://node.example/api/v1/stac/search'
    try {
      const get = await onRequest(makeCtx({ env, url }) as never)
      for (const method of ['GET', 'HEAD']) {
        for (const validator of ['*', get.headers.get('etag')!]) {
          const response = await onRequest(makeCtx({ env, url, method, headers: { 'If-None-Match': validator } }) as never)
          expect(response.status).toBe(304)
          expect(await response.text()).toBe('')
        }
      }
      for (const validator of ['*', get.headers.get('etag')!]) {
        const response = await onRequest({ ...makeCtx({ env, url }), request: new Request(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'If-None-Match': validator }, body: '{}',
        }) } as never)
        expect(response.status).toBe(200)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(await response.json()).toMatchObject({ type: 'FeatureCollection' })
      }
    } finally { sqlite.close() }
  })

  it.each(['item', 'collection-items', 'search', 'api'])('accepts plain JSON for %s', async resource => {
    const { sqlite, ids, env } = stacRouteFixture()
    try {
      const path = resource === 'item' ? `items/${ids[0]}` : resource === 'collection-items' ? `collections/NODE000-${ids[0]}/items` : resource
      const response = await onRequestGet(makeCtx({ env, url: `https://node.example/api/v1/stac/${path}`, headers: { Accept: 'application/json' } }) as never)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain(resource === 'api' ? 'application/vnd.oai.openapi+json' : 'application/geo+json')
      expect(await response.json()).toBeTruthy()
      expect((await onRequestGet(makeCtx({ env, url: `https://node.example/api/v1/stac/${path}`, headers: { Accept: 'application/json;q=0' } }) as never)).status).toBe(406)
    } finally { sqlite.close() }
  })

  it('allows public cross-origin preflight without reading or probing the publication', async () => {
    const { sqlite, env } = stacRouteFixture()
    try {
      const response = await onRequestOptions(makeCtx({ env, url: 'https://node.example/api/v1/stac/search', method: 'OPTIONS', headers: {
        Origin: 'https://browser.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type',
      } }) as never)
      expect(response.status).toBe(204)
      expect(await response.text()).toBe('')
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      expect(response.headers.get('access-control-allow-methods')).toContain('POST')
      expect(response.headers.get('access-control-allow-headers')).toContain('Content-Type')
      expect(response.headers.get('access-control-max-age')).toBe('600')
      expect(response.headers.has('access-control-allow-credentials')).toBe(false)
      expect(fetch).not.toHaveBeenCalled()
      const unknown = await onRequestOptions(makeCtx({ env, url: 'https://node.example/api/v1/stac/unknown/path', method: 'OPTIONS' }) as never)
      expect(unknown.status).toBe(404)
      expect(unknown.headers.get('access-control-allow-origin')).toBe('*')
      expect(unknown.headers.has('access-control-max-age')).toBe(false)
      expect(fetch).not.toHaveBeenCalled()
      const disabled = await onRequestOptions(makeCtx({ env: { ...env, STAC_ENABLED: 'false' }, url: 'https://node.example/api/v1/stac/search', method: 'OPTIONS' }) as never)
      expect(disabled.status).toBe(404)
    } finally { sqlite.close() }
  })

  it('adds CORS to success, HEAD, conditional, POST, and error responses', async () => {
    const { sqlite, env } = stacRouteFixture()
    try {
      const url = 'https://node.example/api/v1/stac/search'
      const get = await onRequestGet(makeCtx({ env, url }) as never)
      const cases: (Partial<Parameters<typeof makeCtx>[0]> & { status: number; body?: string })[] = [
        { method: 'HEAD', status: 200 },
        { headers: { 'If-None-Match': get.headers.get('etag')! }, status: 304 },
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', status: 200 },
        { headers: { Accept: 'text/html' }, status: 406 },
        { method: 'DELETE', status: 405 },
        { url: url + '?limit=0', status: 400 },
        { url: 'https://node.example/api/v1/stac/items/missing', status: 404 },
        { env: { ...env, CATALOG_DB: undefined }, status: 503 },
      ]
      expect(get.headers.get('access-control-allow-origin')).toBe('*')
      for (const { status, body, ...options } of cases) {
        const context = makeCtx({ env, url, ...options })
        const response = await onRequestGet({ ...context, ...(body === undefined ? {} : {
          request: new Request(options.url ?? url, { method: options.method, headers: options.headers, body }),
        }) } as never)
        expect(response.status).toBe(status)
        expect(response.headers.get('access-control-allow-origin')).toBe('*')
        expect(response.headers.get('access-control-expose-headers')).toBe('ETag, Link')
        expect(response.headers.has('access-control-allow-credentials')).toBe(false)
      }
    } finally { sqlite.close() }
  })
})