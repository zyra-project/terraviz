// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestGet } from './[[path]]'
import { asD1, makeCtx, makeKV, seedFixtures } from '../_lib/test-helpers'
import { onRequestGet as schemaGet } from '../../../schema/stac/terraviz/v1.0.0/schema.json'
import { onRequestGet as discoveryGet } from '../../../.well-known/terraviz.json'
import schema from '../../../../docs/metadata/schemas/terraviz-v1.0.0.json'
import { stacRouteFixture } from '../_lib/stac-test-helpers'
import { readStacPublicationInput } from '../_lib/stac-publication-store'
import { readStacPublication } from '../_lib/stac-publication'
import type { StacCatalog, StacCollection, StacItem, StacLink } from '../_lib/stac-types'

describe('STAC public routes', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'Content-Type': 'image/png' } }))))
  afterEach(() => vi.unstubAllGlobals())

  it.each(['search', 'conformance', 'collections/missing', 'items/missing', 'collections/missing/items'])('returns no-store 404 for unsupported or missing %s', async path => {
    const { sqlite, env } = stacRouteFixture()
    try {
      const response = await onRequestGet(makeCtx({ env, url: `https://node.example/api/v1/stac/${path}` }) as never)
      expect(response.status).toBe(404)
      expect(response.headers.get('cache-control')).toBe('no-store')
    } finally { sqlite.close() }
  })

  it('limits a collection item list to that collection and rejects cross-collection lookups', async () => {
    const { sqlite, ids, env } = stacRouteFixture(2)
    try {
      const publication = await readStacPublication(env)
      const collectionId = publication.products[0].collection!.id
      const url = `https://node.example/api/v1/stac/collections/${collectionId}/items`
      const response = await onRequestGet(makeCtx({ env, url }) as never)
      const body = await response.json() as { features: StacItem[] }
      expect(body.features.map(item => item.id)).toEqual([ids[0]])
      expect((await onRequestGet(makeCtx({ env, url: `${url}/${ids[1]}` }) as never)).status).toBe(404)
    } finally { sqlite.close() }
  })

  it('invalidates resolved R2 asset URLs when deployment configuration changes', async () => {
    const { sqlite, ids, env } = stacRouteFixture()
    try {
      sqlite.exec("UPDATE datasets SET data_ref='r2:images/field.png'")
      const configured = { ...env, R2_PUBLIC_BASE: 'https://assets.example' }
      const url = `https://node.example/api/v1/stac/items/${ids[0]}`
      const first = await onRequestGet(makeCtx({ env: configured, url }) as never)
      configured.R2_PUBLIC_BASE = 'https://new-assets.example'
      const second = await onRequestGet(makeCtx({ env: configured, url, headers: { 'if-none-match': first.headers.get('etag')! } }) as never)
      expect(second.status).toBe(200)
      expect((await second.json() as StacItem).assets.data.href).toBe('https://new-assets.example/images/field.png')
    } finally { sqlite.close() }
  })

  it('serves canonical absolute links and the right media types without trusting the request host', async () => {
    const { sqlite, env } = stacRouteFixture()
    try {
      const publication = await readStacPublication(env)
      for (const document of [publication.catalog, publication.products[0].collection!, publication.products[0].item!]) {
        const self = document.links.find(link => link.rel === 'self')!
        const response = await onRequestGet(makeCtx({ env, url: self.href.replace('node.example', 'spoof.example') }) as never)
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain(document.type === 'Feature' ? 'application/geo+json' : 'application/json')
        const result = await response.json() as StacCatalog | StacCollection | StacItem
        expect(result).toEqual(document)
        expect(result.links.every(link => new URL(link.href).protocol === 'https:')).toBe(true)
        expect(result.links.find(link => link.rel === 'self')?.href).toBe(self.href)
        expect(JSON.stringify(result)).not.toMatch(/spoof\.example|conformsTo/)
      }
      const product = publication.products[0]
      const alias = `https://node.example/api/v1/stac/collections/${product.collection!.id}/items/${product.item!.id}`
      expect(await (await onRequestGet(makeCtx({ env, url: alias }) as never)).json()).toEqual(product.item)
    } finally { sqlite.close() }
  })

  it.each(['collections', 'items'])('paginates %s with stable absolute next links and no duplicates', async kind => {
    const { sqlite, ids, env } = stacRouteFixture(5)
    try {
      let href: string | undefined = `https://node.example/api/v1/stac/${kind}?limit=2`
      const seen: string[] = []
      let pages = 0
      while (href) {
        const response = await onRequestGet(makeCtx({ env, url: href }) as never)
        expect(response.status).toBe(200)
        const page = await response.json() as { collections?: StacCollection[]; features?: StacItem[]; links: StacLink[] }
        const records = page.collections ?? page.features!
        expect(records.length).toBeLessThanOrEqual(2)
        seen.push(...records.map(record => record.id))
        href = page.links.find(link => link.rel === 'next')?.href
        if (href) expect(href).toMatch(/^https:\/\/node\.example\/api\/v1\/stac\//)
        expect(++pages).toBeLessThanOrEqual(3)
      }
      expect(pages).toBe(3)
      expect(new Set(seen).size).toBe(5)
      expect(seen.every(id => ids.some(datasetId => id.includes(datasetId)))).toBe(true)
    } finally { sqlite.close() }
  })

  it.each(['limit=0', 'limit=101', 'limit=-1', 'limit=1.5', 'limit=abc', 'cursor=unknown', 'bbox=0,0,1,1'])('rejects malformed/unsupported listing query %s', async query => {
    const { sqlite, env } = stacRouteFixture()
    try {
      const response = await onRequestGet(makeCtx({ env, url: `https://node.example/api/v1/stac/items?${query}` }) as never)
      expect(response.status).toBe(400)
      expect(response.headers.get('cache-control')).toBe('no-store')
    } finally { sqlite.close() }
  })

  it.each(['exact', 'weak', 'list', 'wildcard'])('handles %s conditional validators after current eligibility reads', async mode => {
    const { sqlite, ids, env } = stacRouteFixture()
    try {
      const url = `https://node.example/api/v1/stac/items/${ids[0]}`
      const first = await onRequestGet(makeCtx({ env, url }) as never)
      const etag = first.headers.get('etag')!
      const validator = mode === 'weak' ? `W/${etag}` : mode === 'list' ? `"old", W/${etag}` : mode === 'wildcard' ? '*' : etag
      const second = await onRequestGet(makeCtx({ env, url, headers: { 'if-none-match': validator } }) as never)
      expect(second.status).toBe(304)
      expect(await second.text()).toBe('')
      expect(second.headers.get('etag')).toBe(etag)
      expect(second.headers.get('cache-control')).toBe('public, no-cache, must-revalidate')
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(env.CATALOG_DB.withSession).toHaveBeenCalledTimes(2)
    } finally { sqlite.close() }
  })

  it('invalidates the Catalog ETag immediately when node description changes or is cleared', async () => {
    const { sqlite, env } = stacRouteFixture()
    try {
      const url = 'https://node.example/api/v1/stac'
      let response = await onRequestGet(makeCtx({ env, url }) as never)
      for (const description of ['New public description', null]) {
        const oldEtag = response.headers.get('etag')!
        sqlite.prepare('UPDATE node_identity SET description=?').run(description)
        response = await onRequestGet(makeCtx({ env, url, headers: { 'if-none-match': oldEtag } }) as never)
        expect(response.status).toBe(200)
        expect(response.headers.get('etag')).not.toBe(oldEtag)
        expect((await response.clone().json() as StacCatalog).description).toBe(description ?? 'Scientific data catalog for Test Node.')
      }
    } finally { sqlite.close() }
  })

  it('invalidates logo changes/removal while private draft edits leave the Catalog and cache unchanged', async () => {
    const { sqlite, env } = stacRouteFixture()
    try {
      sqlite.exec(`INSERT INTO publishers (id,email,display_name,role,status,created_at)
        VALUES ('PUB','editor@example.test','Editor','admin','active','2026-01-01');
        INSERT INTO node_profile (id,org_name,logo_ref,mission,updated_by,updated_at)
        VALUES (1,'Organization','https://data.example/logo.png','Private mission','PUB','2026-01-01')`)
      const url = 'https://node.example/api/v1/stac'
      let response = await onRequestGet(makeCtx({ env, url }) as never)
      let body = await response.clone().json() as StacCatalog
      expect(body.links.find(link => link.rel === 'icon')?.href).toBe('https://data.example/logo.png')
      const originalEtag = response.headers.get('etag')!
      const originalKeys = [...env.CATALOG_KV._store.keys()]
      sqlite.exec("UPDATE node_profile SET mission='Never publish this', updated_at='2026-09-18'")
      expect((await onRequestGet(makeCtx({ env, url, headers: { 'if-none-match': originalEtag } }) as never)).status).toBe(304)
      expect([...env.CATALOG_KV._store.keys()]).toEqual(originalKeys)
      for (const logo of ['https://data.example/new-logo.png', null]) {
        const etag = response.headers.get('etag')!
        sqlite.prepare('UPDATE node_profile SET logo_ref=?').run(logo)
        response = await onRequestGet(makeCtx({ env, url, headers: { 'if-none-match': etag } }) as never)
        expect(response.status).toBe(200)
        expect(response.headers.get('etag')).not.toBe(etag)
        body = await response.json() as StacCatalog
        expect(body.links.find(link => link.rel === 'icon')?.href ?? null).toBe(logo)
        expect(JSON.stringify(body)).not.toContain('Never publish this')
      }
    } finally { sqlite.close() }
  })

  it.each(['title', 'decoration', 'rendition', 'asset'])('invalidates an Item after a %s change without relying on timestamps', async change => {
    const { sqlite, ids, env } = stacRouteFixture()
    try {
      const url = `https://node.example/api/v1/stac/items/${ids[0]}`
      const first = await onRequestGet(makeCtx({ env, url }) as never)
      const etag = first.headers.get('etag')!
      if (change === 'title') sqlite.exec("UPDATE datasets SET title='Updated scientific image'")
      if (change === 'decoration') sqlite.prepare('INSERT INTO dataset_keywords (dataset_id,keyword) VALUES (?,?)').run(ids[0], 'new keyword')
      if (change === 'asset') sqlite.exec("UPDATE datasets SET data_ref='url:https://data.example/replacement.png'")
      if (change === 'rendition') sqlite.prepare(`INSERT INTO dataset_renditions
        (dataset_id,rendition_id,codec,color_space,bit_depth,width,height,ref,mime_type,created_at)
        VALUES (?,'REN','png','srgb',8,100,50,'url:https://data.example/rendition.png','image/png','2026-01-01')`).run(ids[0])
      const response = await onRequestGet(makeCtx({ env, url, headers: { 'if-none-match': etag } }) as never)
      expect(response.status).toBe(200)
      expect(response.headers.get('etag')).not.toBe(etag)
    } finally { sqlite.close() }
  })

  it.each(['get', 'put'] as const)('remains correct when KV %s fails', async operation => {
    const { sqlite, env } = stacRouteFixture()
    try {
      vi.mocked(env.CATALOG_KV[operation]).mockRejectedValue(new Error('KV unavailable'))
      const response = await onRequestGet(makeCtx({ env, url: 'https://node.example/api/v1/stac/items' }) as never)
      expect(response.status).toBe(200)
      expect((await response.json() as { features: StacItem[] }).features).toHaveLength(1)
    } finally { sqlite.close() }
  })

  it('never serves a previously cached response when the fresh database read fails', async () => {
    const { sqlite, env } = stacRouteFixture()
    try {
      const url = 'https://node.example/api/v1/stac'
      const first = await onRequestGet(makeCtx({ env, url }) as never)
      vi.mocked(env.CATALOG_DB.withSession).mockImplementation(() => { throw new Error('Database offline') })
      const response = await onRequestGet(makeCtx({ env, url, headers: { 'if-none-match': first.headers.get('etag')! } }) as never)
      expect(response.status).toBe(503)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.text()).not.toContain('Database offline')
    } finally { sqlite.close() }
  })

  it.each(['unknown-geometry', 'unknown-time'])('preserves truthful standalone %s resources', async mode => {
    const { sqlite, env } = stacRouteFixture()
    try {
      sqlite.exec(mode === 'unknown-geometry' ? "UPDATE datasets SET bbox_provenance='unknown'" : "UPDATE datasets SET temporal_semantics='unknown'")
      const publication = await readStacPublication(env)
      const product = publication.products[0]
      if (mode === 'unknown-geometry') {
        expect(product.collection).toBeNull()
        expect(product.item?.geometry).toBeNull()
        expect(product.item).not.toHaveProperty('bbox')
        expect(publication.catalog.links.some(link => link.rel === 'item')).toBe(true)
      } else {
        expect(product.item).toBeNull()
        expect(product.collection?.extent.temporal.interval).toEqual([[null, null]])
        expect(publication.catalog.links.some(link => link.rel === 'child')).toBe(true)
      }
    } finally { sqlite.close() }
  })

  it('uses one primary transactional batch and never reads private profile prose', async () => {
    const { sqlite, env } = stacRouteFixture()
    try {
      sqlite.exec(`INSERT INTO publishers (id,email,display_name,role,status,created_at)
        VALUES ('PRIVATE EDITOR','editor@example.test','Editor','admin','active','2026-01-01');
        INSERT INTO node_profile (id, org_name, mission, about_md, updated_by, updated_at)
        VALUES (1, 'Public organization', 'PRIVATE MISSION', 'PRIVATE ABOUT', 'PRIVATE EDITOR', '2026-09-18')`)
      const model = await readStacPublicationInput(env.CATALOG_DB)
      expect(model.datasets).toHaveLength(1)
      expect(model.branding).toEqual({ org_name: 'Public organization', logo_ref: null })
      expect(JSON.stringify(model)).not.toContain('PRIVATE')
      expect(env.CATALOG_DB.withSession).toHaveBeenCalledExactlyOnceWith('first-primary')
    } finally { sqlite.close() }
  })

  it('withholds mutable workflow outputs even when their workflow is disabled', async () => {
    const { sqlite, env } = stacRouteFixture()
    try {
      sqlite.exec(`INSERT INTO publishers (id,email,display_name,role,status,created_at)
        VALUES ('PUB','publisher@example.test','Publisher','service','active','2026-01-01');
        INSERT INTO workflows (id,publisher_id,name,pipeline_json,metadata_template,schedule,target_dataset_id,created_at,updated_at)
        SELECT 'WF','PUB','Recurring','{}','{}','P1D',id,'2026-01-01','2026-01-01' FROM datasets`)
      const response = await onRequestGet(makeCtx({ env, url: 'https://node.example/api/v1/stac/items' }) as never)
      expect(await response.json()).toMatchObject({ features: [] })
      expect(fetch).not.toHaveBeenCalled()
    } finally { sqlite.close() }
  })

  it('withholds a valid URL whose actual media is incompatible with the native manifest', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'Content-Type': 'video/mp4' } })))
    const { sqlite, env } = stacRouteFixture()
    try {
      const response = await onRequestGet(makeCtx({ env, url: 'https://node.example/api/v1/stac/items' }) as never)
      expect(await response.json()).toMatchObject({ features: [] })
    } finally { sqlite.close() }
  })

  it.each([401, 403, 404, 302, 405])('withholds assets whose anonymous HEAD returns %s', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status, headers: { 'Content-Type': 'image/png' } })))
    const { sqlite, env } = stacRouteFixture()
    try {
      const response = await onRequestGet(makeCtx({ env, url: 'https://node.example/api/v1/stac/items' }) as never)
      expect(await response.json()).toMatchObject({ features: [] })
      expect(fetch).toHaveBeenCalledWith('https://data.example/image.png', expect.objectContaining({ method: 'HEAD', redirect: 'manual', credentials: 'omit' }))
    } finally { sqlite.close() }
  })

  it('does not fetch or publish an origin not explicitly allowlisted', async () => {
    const { sqlite, env } = stacRouteFixture()
    try {
      env.STAC_ASSET_ORIGINS = ''
      const response = await onRequestGet(makeCtx({ env, url: 'https://node.example/api/v1/stac/items' }) as never)
      expect(await response.json()).toMatchObject({ features: [] })
      expect(fetch).not.toHaveBeenCalled()
    } finally { sqlite.close() }
  })
  it.each(["visibility='private'", "visibility='restricted'", "visibility='federated'", 'is_hidden=1',
    "retracted_at='2026-09-18T00:00:00Z'", 'published_at=NULL', 'transcoding=1', "celestial_body='Mars'",
    "resource_kind='presentation'", "bbox_provenance='inferred'", "data_ref='vimeo:123'", "license_spdx=NULL"])(
    'withholds %s from direct and cached public reads', async change => {
      const { sqlite, ids, env } = stacRouteFixture()
      try {
        const url = `https://node.example/api/v1/stac/items/${ids[0]}`
        const first = await onRequestGet(makeCtx({ env, url }) as never)
        expect(first.status).toBe(200)
        const etag = first.headers.get('etag')!
        sqlite.exec(`UPDATE datasets SET ${change}`)
        const second = await onRequestGet(makeCtx({ env, url, headers: { 'if-none-match': etag } }) as never)
        expect(second.status).toBe(404)
        const catalog = await onRequestGet(makeCtx({ env, url: 'https://node.example/api/v1/stac' }) as never)
        expect(await catalog.text()).not.toContain(ids[0])
        expect(env.CATALOG_DB.withSession).toHaveBeenCalledWith('first-primary')
      } finally { sqlite.close() }
    })
  it('serves the reviewed immutable schema independently of publication opt-in', async () => {
    const response = await schemaGet({} as never)
    expect(response.headers.get('content-type')).toContain('application/schema+json')
    expect(response.headers.get('cache-control')).toContain('immutable')
    expect(await response.json()).toEqual(schema)
  })

  it('adds opt-in discovery as a header without changing the native JSON contract', async () => {
    const sqlite = seedFixtures({ count: 0, baseUrl: 'https://node.example' })
    try {
      const env = { CATALOG_DB: asD1(sqlite) }
      const disabled = await discoveryGet(makeCtx({ env }) as never)
      const enabled = await discoveryGet(makeCtx({ env: { ...env, STAC_ENABLED: 'true' } }) as never)
      expect(disabled.headers.has('link')).toBe(false)
      expect(enabled.headers.get('link')).toContain('https://node.example/api/v1/stac')
      expect(await enabled.json()).toEqual(await disabled.json())
    } finally { sqlite.close() }
  })
  it('publishes an identity-only Catalog and uses its own KV namespace', async () => {
    const sqlite = seedFixtures({ count: 0, baseUrl: 'https://node.example' })
    const kv = makeKV()
    try {
      sqlite.exec("UPDATE node_identity SET description='Public node description'")
      const response = await onRequestGet(makeCtx({ env: { STAC_ENABLED: 'true', CATALOG_DB: asD1(sqlite), CATALOG_KV: kv }, url: 'https://node.example/api/v1/stac' }) as never)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ type: 'Catalog', description: 'Public node description' })
      expect([...kv._store.keys()]).toEqual([expect.stringMatching(/^stac:publication:v1:/)])
    } finally { sqlite.close() }
  })
  it('does not publish existing descriptions without deployment opt-in', async () => {
    const response = await onRequestGet({ env: {}, request: new Request('https://node.example/api/v1/stac') } as never)
    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ error: 'not_found' })
  })
})