// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stacRouteFixture } from './stac-test-helpers'
import { serveStac } from './stac-http'
import { publishDataset } from './dataset-mutations'
import { stampTranscodingForVideoSource } from './asset-uploads'
import { readStacPublication } from './stac-publication'
import { MAX_INTERSECTS_POSITIONS, MAX_INTERSECTS_POSITION_TESTS } from './stac-query'
import type { CatalogEnv } from './env'
import type { StacItem, StacLink } from './stac-types'

interface Page { features: StacItem[]; links: StacLink[]; numberMatched: number }
const root = 'https://node.example/api/v1/stac'

describe('STAC Item Search', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'Content-Type': 'image/png' } }))))
  afterEach(() => vi.unstubAllGlobals())

  it('searches by IDs and collections using identical GET and POST results and GET next links', async () => {
    const { sqlite, ids, env } = stacRouteFixture(3)
    try {
      const query = { ids: ids.slice(0, 2), collections: ids.slice(0, 2).map(id => `NODE000-${id}`), limit: 1 }
      const post = await serveStac(new Request(`${root}/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query) }), env)
      expect(post.status).toBe(200)
      const first = await post.json() as Page
      expect(first.numberMatched).toBe(2)
      expect(first.features.map(item => item.id)).toEqual([ids[0]])
      const next = first.links.find(link => link.rel === 'next')!
      expect(next.method).toBe('POST')
      const second = await (await serveStac(new Request(next.href, { method: next.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next.body) }), env)).json() as Page
      expect(second.features.map(item => item.id)).toEqual([ids[1]])
      const get = await (await serveStac(new Request(`${root}/search?ids=${ids.slice(0, 2)}&collections=${query.collections}&limit=1`), env)).json()
      expect(get).toMatchObject({ features: first.features, numberMatched: first.numberMatched })
    } finally { sqlite.close() }
  })

  it.each([
    { type: 'Point', coordinates: [0, 0] },
    { type: 'MultiPoint', coordinates: [[0, 0], [1, 1]] },
    { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
    { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]]] },
    { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
    { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] },
    { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [0, 0] }] },
  ])('supports intersects geometry $type', async geometry => {
    const { sqlite, ids, env } = stacRouteFixture()
    try {
      const response = await serveStac(new Request(`${root}/search?intersects=${encodeURIComponent(JSON.stringify(geometry))}`), env)
      expect(response.status).toBe(200)
      expect((await response.json() as Page).features.map(item => item.id)).toEqual(ids)
    } finally { sqlite.close() }
  })

  it.each(['GET', 'POST'])('continues %s pagination after the cursor Item goes private', async method => {
    const { sqlite, ids, env } = stacRouteFixture(3)
    try {
      const request = (cursor?: string) => method === 'GET'
        ? new Request(`${root}/search?limit=1${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`)
        : new Request(`${root}/search`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 1, ...(cursor ? { cursor } : {}) }) })
      const first = await (await serveStac(request(), env)).json() as Page
      expect(first.features[0].id).toBe(ids[0])
      sqlite.prepare("UPDATE datasets SET visibility='private' WHERE id=?").run(ids[0])
      const response = await serveStac(request(ids[0]), env)
      expect(response.status).toBe(200)
      expect((await response.json() as Page).features.map(item => item.id)).toEqual([ids[1]])
      const end = await serveStac(request(ids[2]), env)
      expect(end.status).toBe(200)
      expect((await end.json() as Page).features).toEqual([])
    } finally { sqlite.close() }
  })

  it('continues the global Item list after its cursor goes private', async () => {
    const { sqlite, ids, env } = stacRouteFixture(3)
    try {
      const first = await (await serveStac(new Request(`${root}/items?limit=1`), env)).json() as Page
      const next = first.links.find(link => link.rel === 'next')!
      sqlite.prepare("UPDATE datasets SET visibility='private' WHERE id=?").run(ids[0])
      const response = await serveStac(new Request(next.href), env)
      expect(response.status).toBe(200)
      expect((await response.json() as Page).features.map(item => item.id)).toEqual([ids[1]])
    } finally { sqlite.close() }
  })

  it('strips validated bbox metadata from POST self and next link geometries', async () => {
    const { sqlite, env } = stacRouteFixture(2)
    try {
      const response = await serveStac(new Request(`${root}/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 1, intersects: { type: 'GeometryCollection', bbox: [0, 0, 0, 0],
          geometries: [{ type: 'Point', coordinates: [0, 0], bbox: [0, 0, 0, 0] }] } }) }), env)
      expect(response.status).toBe(200)
      const page = await response.json() as Page
      const links = page.links.filter(link => ['self', 'next'].includes(link.rel))
      expect(links).toHaveLength(2)
      for (const link of links) expect(link.body?.intersects).toEqual({ type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [0, 0] }] })
    } finally { sqlite.close() }
  })

  it('handles bbox crossings, elevation zero and null geometry', async () => {
    const { sqlite, ids, env } = stacRouteFixture(2)
    try {
      sqlite.prepare('UPDATE datasets SET bbox_w=170,bbox_e=-170 WHERE id=?').run(ids[0])
      sqlite.prepare("UPDATE datasets SET bbox_provenance='unknown',bbox_evidence=NULL,bbox_n=NULL,bbox_s=NULL,bbox_e=NULL,bbox_w=NULL WHERE id=?").run(ids[1])
      const page = async (bbox: string) => await (await serveStac(new Request(`${root}/search?bbox=${bbox}`), env)).json() as Page
      expect((await page('175,-1,-175,1')).features.map(item => item.id)).toEqual([ids[0]])
      expect((await page('0,-1,1,1')).features).toEqual([])
      expect((await page('175,-1,1,179,1,2')).features).toEqual([])
    } finally { sqlite.close() }
  })

  it.each(['2026-05-31T12:00:00Z', '../9999-12-31T23:00:00-05:00'])('agrees with browse for JS-valid offset and far datetime %s', async datetime => {
    const { sqlite, ids, env } = stacRouteFixture()
    try {
      sqlite.exec("UPDATE datasets SET start_time='2026-06-01T00:00:00+15:00',end_time='2026-06-02T00:00:00+15:00'")
      const browse = await (await serveStac(new Request(`${root}/collections/NODE000-${ids[0]}/items`), env)).json() as Page
      expect(browse.features).toHaveLength(1)
      const search = await (await serveStac(new Request(`${root}/search?datetime=${encodeURIComponent(datetime)}`), env)).json() as Page
      expect(search.features).toEqual(browse.features)
    } finally { sqlite.close() }
  })

  it('filters individual frame times and never leaks stale or private saved Items', async () => {
    const { sqlite, ids, env: base } = stacRouteFixture()
    const env: CatalogEnv = { ...base, STAC_HISTORY_CAPTURE: 'true', R2_PUBLIC_BASE: 'https://data.example',
      CATALOG_R2: { get: async () => ({ text: async () => JSON.stringify([{ index: 0, filename: 'one.png', digest: `sha256:${'a'.repeat(64)}` }, { index: 1, filename: 'two.png', digest: `sha256:${'b'.repeat(64)}` }]) }) } as unknown as R2Bucket }
    try {
      sqlite.exec("UPDATE datasets SET slug='frame-sequence',frame_count=2,frame_extension='png',frame_source_filenames_ref='r2:manifest.json',period='P1D',format='video/mp4'")
      sqlite.prepare('UPDATE datasets SET source_digest=?').run(`sha256:${'c'.repeat(64)}`)
      expect(await publishDataset(env, ids[0])).toMatchObject({ ok: true })
      const page = async () => await (await serveStac(new Request(`${root}/search?datetime=2026-01-02T00:00:00Z`), env)).json() as Page
      expect((await page()).features.map(item => item.properties.datetime)).toEqual(['2026-01-02T00:00:00.000Z'])
      const browse = async () => await (await serveStac(new Request(`${root}/collections/NODE000-${ids[0]}/items`), env)).json() as Page
      const search = async () => await (await serveStac(new Request(`${root}/search?collections=NODE000-${ids[0]}`), env)).json() as Page
      expect((await browse()).features).toHaveLength(2)
      const source = sqlite.prepare('SELECT source_digest FROM datasets WHERE id=?').get(ids[0]) as { source_digest: string | null }
      expect(await stampTranscodingForVideoSource(env.CATALOG_DB!, ids[0], {
        id: 'retranscode', claimed_digest: source.source_digest,
      } as Parameters<typeof stampTranscodingForVideoSource>[2], '2026-10-05T00:00:00Z')).toBe(1)
      expect((await search()).features).toEqual((await browse()).features)
      expect((await search()).features).toHaveLength(2)
      const saved = (await browse()).features
      expect(sqlite.prepare('DELETE FROM stac_history_items WHERE julianday(start_time)=julianday(?)').run(saved[0].properties.datetime).changes).toBe(1)
      for (const path of ['items', `collections/NODE000-${ids[0]}/items`]) {
        const response = await serveStac(new Request(`${root}/${path}?limit=1&cursor=${encodeURIComponent(saved[0].id)}`), env)
        expect(response.status).toBe(200)
        expect((await response.json() as Page).features.map(item => item.id)).toEqual([saved[1].id])
      }
      sqlite.exec("UPDATE datasets SET visibility='private'")
      expect((await page()).features).toEqual([])
      sqlite.exec("UPDATE datasets SET visibility='public',frame_source_filenames_ref='r2:changed.json'")
      expect((await page()).features).toEqual([])
    } finally { sqlite.close() }
  })

  it.each([
    [{ ids: [] }, 400], [{ cursor: 'x'.repeat(257) }, 400],
    [{ intersects: { type: 'Point', coordinates: [0, 0], bbox: 'garbage' } }, 400],
    [{ intersects: { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [0, 0], bbox: 'garbage' }] } }, 400],
    [{ bbox: [0, 0, 1, 1], intersects: { type: 'Point', coordinates: [0, 0] } }, 400],
    [{ ids: 'not-an-array' }, 400], [{ limit: '1' }, 400], [{ ids: ['one,two'] }, 400],
    [{ datetime: '2026-02-30T00:00:00Z' }, 400], [{ intersects: { type: 'Feature' } }, 400],
    [{ intersects: { type: 'Polygon', coordinates: [[[100, 0], [101, 0], [101, 1], [102, 2]]] } }, 400],
    [{ intersects: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] } }, 400],
    [{ intersects: { type: 'MultiPolygon', coordinates: [[], [[[0, 0], [1, 0], [1, 1], [0, 0]]]] } }, 400],
    [{ unknown: 1 }, 400], [[], 400], [null, 400],
  ])('rejects invalid POST %j', async (body, status) => {
    const { sqlite, env } = stacRouteFixture()
    try {
      const response = await serveStac(new Request(`${root}/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env)
      expect(response.status).toBe(status)
      expect(fetch).not.toHaveBeenCalled()
    } finally { sqlite.close() }
  })

  it.each([
    { type: 'Polygon', coordinates: [[[100, 0], [101, 0], [101, 1], [102, 2]]] },
    { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] },
    { type: 'MultiPolygon', coordinates: [[], [[[0, 0], [1, 0], [1, 1], [0, 0]]]] },
    { type: 'MultiLineString', coordinates: [[], [[0, 0], [1, 1]]] },
    { type: 'GeometryCollection', geometries: [{ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }] },
  ])('rejects malformed GET geometry before publication reads: %j', async geometry => {
    const { sqlite, env } = stacRouteFixture()
    try {
      const response = await serveStac(new Request(`${root}/search?intersects=${encodeURIComponent(JSON.stringify(geometry))}`), env)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: 'invalid_intersects', code: 'invalid_intersects', description: expect.any(String) })
      expect(fetch).not.toHaveBeenCalled()
    } finally { sqlite.close() }
  })

  it('keeps workflow history in browse, search and the report during a same-source retranscode', async () => {
    const { sqlite, ids, env: base } = stacRouteFixture()
    const env: CatalogEnv = { ...base, STAC_HISTORY_CAPTURE: 'true', R2_PUBLIC_BASE: 'https://data.example' }
    const digest = `sha256:${'c'.repeat(64)}`
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } })))
    try {
      sqlite.exec(`INSERT INTO publishers (id,email,display_name,role,status,created_at)
        VALUES ('PUB','publisher@example.test','Publisher','service','active','2026-01-01');
        INSERT INTO workflows (id,publisher_id,name,pipeline_json,metadata_template,schedule,target_dataset_id,created_at,updated_at)
        SELECT 'WF','PUB','Recurring','{}','{}','P1D',id,'2026-01-01','2026-01-01' FROM datasets`)
      sqlite.prepare("UPDATE datasets SET slug='workflow-output',format='video/mp4',data_ref=?,source_digest=? WHERE id=?")
        .run(`r2:videos/${ids[0]}/01ARZ3NDEKTSV4RRFFQ69G5FAV/master.m3u8`, digest, ids[0])
      expect(await publishDataset(env, ids[0])).toMatchObject({ ok: true })
      const before = await readStacPublication(env)
      expect(before.products).toHaveLength(1)
      expect(await stampTranscodingForVideoSource(env.CATALOG_DB!, ids[0], {
        id: 'retranscode', claimed_digest: digest,
      } as Parameters<typeof stampTranscodingForVideoSource>[2], '2026-10-05T00:00:00Z')).toBe(1)
      const browse = await (await serveStac(new Request(`${root}/collections/NODE000-${ids[0]}/items`), env)).json() as Page
      const search = await (await serveStac(new Request(`${root}/search?collections=NODE000-${ids[0]}`), env)).json() as Page
      expect(browse.features).toHaveLength(1)
      expect(search.features).toEqual(browse.features)
      expect((await readStacPublication(env, { operatorReport: true })).report).toContainEqual(expect.objectContaining({ id: ids[0], included: true, items_included: 1 }))
    } finally { sqlite.close() }
  })

  it('returns an explicit uncached CORS error rather than partial over-budget results', async () => {
    const { sqlite, ids, env } = stacRouteFixture(MAX_INTERSECTS_POSITION_TESTS / MAX_INTERSECTS_POSITIONS + 1)
    try {
      for (const [index, id] of ids.entries()) sqlite.prepare('UPDATE datasets SET bbox_w=? WHERE id=?').run(-60 + index * 0.001, id)
      const ring = Array.from({ length: MAX_INTERSECTS_POSITIONS - 1 }, (_, index) => {
        const angle = index * 2 * Math.PI / (MAX_INTERSECTS_POSITIONS - 1)
        return [Math.cos(angle), Math.sin(angle)]
      })
      ring.push(ring[0])
      const geometry = encodeURIComponent(JSON.stringify({ type: 'Polygon', coordinates: [ring] }))
      const response = await serveStac(new Request(`${root}/search?intersects=${geometry}`), env)
      expect(response.status).toBe(400)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      expect(await response.json()).toMatchObject({ error: 'intersects_budget_exceeded', code: 'intersects_budget_exceeded', description: expect.any(String) })
    } finally { sqlite.close() }
  })
  it('searches a real 3650-frame sequence with a maximum polygon regardless of page limit', async () => {
    const { sqlite, ids, env: base } = stacRouteFixture()
    const count = 3650
    const manifest = Array.from({ length: count }, (_, index) => ({ index, filename: `${index}.png`, digest: `sha256:${index.toString(16).padStart(64, '0')}` }))
    const env: CatalogEnv = { ...base, STAC_HISTORY_CAPTURE: 'true', R2_PUBLIC_BASE: 'https://data.example',
      CATALOG_R2: { get: async () => ({ text: async () => JSON.stringify(manifest) }) } as unknown as R2Bucket }
    try {
      sqlite.prepare("UPDATE datasets SET slug='long-frame-sequence',frame_count=?,frame_extension='png',frame_source_filenames_ref='r2:manifest.json',period='P1D',format='video/mp4',end_time='2036-01-01T00:00:00Z'").run(count)
      expect(await publishDataset(env, ids[0])).toMatchObject({ ok: true })
      const ring = Array.from({ length: MAX_INTERSECTS_POSITIONS - 1 }, (_, index) => {
        const angle = index * 2 * Math.PI / (MAX_INTERSECTS_POSITIONS - 1)
        return [Math.cos(angle), Math.sin(angle)]
      })
      ring.push(ring[0])
      const geometry = encodeURIComponent(JSON.stringify({ type: 'Polygon', coordinates: [ring] }))
      const started = performance.now()
      const response = await serveStac(new Request(`${root}/search?collections=NODE000-${ids[0]}&limit=1&intersects=${geometry}`), env)
      if (process.env.STAC_BENCHMARKS === 'true') console.log('STAC_LONG_SEQUENCE', JSON.stringify({ node: process.version, frames: count, elapsedMs: performance.now() - started }))
      expect(response.status).toBe(200)
      const page = await response.json() as Page
      expect(page.numberMatched).toBe(count)
      expect(page.features).toHaveLength(1)
      expect(page.links.some(link => link.rel === 'next')).toBe(true)
    } finally { sqlite.close() }
  }, 60000)
  it('does not expose errors from excessively nested POST JSON', async () => {
    const { sqlite, env } = stacRouteFixture()
    try {
      const body = '{"intersects":' + '['.repeat(20000) + '0' + ']'.repeat(20000) + '}'
      const response = await serveStac(new Request(`${root}/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }), env)
      expect(response.status).toBe(400)
      const error = await response.json() as { error: string; code: string; description: string }
      expect(error).toMatchObject({ error: 'invalid_query', code: 'invalid_query' })
      expect(JSON.stringify(error)).not.toMatch(/stack|RangeError|Maximum call/i)
      expect(fetch).not.toHaveBeenCalled()
    } finally { sqlite.close() }
  })
})