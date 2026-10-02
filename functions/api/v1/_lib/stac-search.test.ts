// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stacRouteFixture } from './stac-test-helpers'
import { serveStac } from './stac-http'
import { publishDataset } from './dataset-mutations'
import type { CatalogEnv } from './env'
import type { StacItem, StacLink } from './stac-types'

interface Page { features: StacItem[]; links: StacLink[]; numberMatched: number }
const root = 'https://node.example/api/v1/stac'

describe('indexed STAC Item Search', () => {
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

  it('indexes individual frame times and never leaks stale or private saved Items', async () => {
    const { sqlite, ids, env: base } = stacRouteFixture()
    const env: CatalogEnv = { ...base, STAC_HISTORY_CAPTURE: 'true', R2_PUBLIC_BASE: 'https://data.example',
      CATALOG_R2: { get: async () => ({ text: async () => JSON.stringify([{ index: 0, filename: 'one.png', digest: `sha256:${'a'.repeat(64)}` }, { index: 1, filename: 'two.png', digest: `sha256:${'b'.repeat(64)}` }]) }) } as unknown as R2Bucket }
    try {
      sqlite.exec("UPDATE datasets SET slug='frame-sequence',frame_count=2,frame_extension='png',frame_source_filenames_ref='r2:manifest.json',period='P1D',format='video/mp4'")
      expect(await publishDataset(env, ids[0])).toMatchObject({ ok: true })
      const page = async () => await (await serveStac(new Request(`${root}/search?datetime=2026-01-02T00:00:00Z`), env)).json() as Page
      expect((await page()).features.map(item => item.properties.datetime)).toEqual(['2026-01-02T00:00:00.000Z'])
      sqlite.exec("UPDATE datasets SET visibility='private'")
      expect((await page()).features).toEqual([])
      sqlite.exec("UPDATE datasets SET visibility='public',frame_source_filenames_ref='r2:changed.json'")
      expect((await page()).features).toEqual([])
    } finally { sqlite.close() }
  })

  it.each([
    [{ bbox: [0, 0, 1, 1], intersects: { type: 'Point', coordinates: [0, 0] } }, 400],
    [{ ids: 'not-an-array' }, 400], [{ limit: '1' }, 400], [{ ids: ['one,two'] }, 400],
    [{ datetime: '2026-02-30T00:00:00Z' }, 400], [{ intersects: { type: 'Feature' } }, 400],
    [{ unknown: 1 }, 400], [[], 400], [null, 400],
  ])('rejects invalid POST %j', async (body, status) => {
    const { sqlite, env } = stacRouteFixture()
    try {
      const response = await serveStac(new Request(`${root}/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env)
      expect(response.status).toBe(status)
      expect(fetch).not.toHaveBeenCalled()
    } finally { sqlite.close() }
  })

  it('has usable geometry and datetime query indexes', () => {
    const { sqlite } = stacRouteFixture()
    try {
      for (const [sql, name] of [
        ["SELECT id FROM datasets WHERE julianday(start_time)<=julianday('2026-01-01')", 'stac_datasets_datetime'],
        ['SELECT id FROM datasets WHERE bbox_s<=30', 'stac_datasets_geometry'],
        ["SELECT id FROM stac_history_items WHERE julianday(start_time)<=julianday('2026-01-01')", 'stac_history_items_datetime'],
        ["SELECT id FROM stac_history_publications WHERE json_extract(model_json,'$.row.bbox_s')<=30", 'stac_history_geometry'],
      ]) {
        const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]
        expect(plan.some(row => row.detail.includes(name))).toBe(true)
      }
    } finally { sqlite.close() }
  })
})