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
import { verifyStacAssets } from '../_lib/stac-assets'
import * as snapshot from '../_lib/snapshot'
import type { StacCatalog, StacCollection, StacItem, StacLink } from '../_lib/stac-types'

describe('STAC public routes', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'Content-Type': 'image/png' } }))))
  afterEach(() => vi.unstubAllGlobals())

  it('advertises deployed listing routes with canonical links and matching media types', async () => {
    const { sqlite, env } = stacRouteFixture()
    try {
      const publication = await readStacPublication(env)
      expect(publication.catalog.links).toEqual(expect.arrayContaining([
        { rel: 'data', href: 'https://node.example/api/v1/stac/collections', type: 'application/json' },
        { rel: 'items', href: 'https://node.example/api/v1/stac/items', type: 'application/geo+json' },
      ]))
      const collection = publication.products[0].collection!
      expect(collection.links).toContainEqual({ rel: 'items', href: `https://node.example/api/v1/stac/collections/${collection.id}/items`, type: 'application/geo+json' })
      for (const link of [...publication.catalog.links, ...collection.links].filter(link => ['data', 'items'].includes(link.rel))) {
        const response = await onRequestGet(makeCtx({ env, url: link.href }) as never)
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain(link.type)
      }
    } finally { sqlite.close() }
  })

  it.each([40, 41, 60])('never publishes a truncated catalog for %s distinct primary URLs', async count => {
    const { sqlite, ids, env } = stacRouteFixture(count)
    try {
      for (const id of ids) sqlite.prepare('UPDATE datasets SET data_ref=? WHERE id=?').run(`url:https://data.example/${id}.png`, id)
      const response = await onRequestGet(makeCtx({ env, url: 'https://node.example/api/v1/stac' }) as never)
      expect(fetch).toHaveBeenCalledTimes(Math.min(count, 40))
      expect(response.status).toBe(count === 40 ? 200 : 503)
      if (count === 40) {
        expect((await response.json() as StacCatalog).links.filter(link => link.rel === 'child')).toHaveLength(40)
      } else {
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(await response.json()).toEqual({ error: 'stac_unavailable' })
        expect(env.CATALOG_KV.put).not.toHaveBeenCalled()
      }
    } finally { sqlite.close() }
  })

  it.each([[6, 2800], [40, 400]])('verifies %s healthy assets at %sms latency within the deadline', async (count, latency) => {
    const { sqlite, ids, env } = stacRouteFixture(count)
    let active = 0
    let peak = 0
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), milliseconds)
      return controller.signal
    })
    vi.stubGlobal('fetch', vi.fn(async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, latency))
      active--
      return new Response(null, { headers: { 'Content-Type': 'image/png' } })
    }))
    try {
      for (const id of ids) sqlite.prepare('UPDATE datasets SET data_ref=?, thumbnail_ref=? WHERE id=?')
        .run(`url:https://data.example/${id}.png`, `https://data.example/${id}.png`, id)
      const model = await readStacPublicationInput(env.CATALOG_DB)
      vi.useFakeTimers()
      const pending = verifyStacAssets(env, model)
      await vi.advanceTimersByTimeAsync(14000)
      const result = await pending
      expect(result.budgetExhausted).toBe(false)
      expect(result.issues.size).toBe(0)
      expect(result.assets.size).toBe(count * 2)
      expect(fetch).toHaveBeenCalledTimes(count)
      expect(peak).toBe(Math.min(count, 16))
    } finally { vi.useRealTimers(); timeout.mockRestore(); sqlite.close() }
  })

  it('records individual probe failures without aborting queued healthy assets', async () => {
    const { sqlite, ids, env } = stacRouteFixture(20)
    vi.stubGlobal('fetch', vi.fn(async (href: string) => {
      if (href.endsWith(`${ids[0]}.png`)) throw new Error('Origin unavailable')
      return new Response(null, { headers: { 'Content-Type': 'image/png' } })
    }))
    try {
      for (const id of ids) sqlite.prepare('UPDATE datasets SET data_ref=? WHERE id=?').run(`url:https://data.example/${id}.png`, id)
      const result = await verifyStacAssets(env, await readStacPublicationInput(env.CATALOG_DB))
      expect(result.budgetExhausted).toBe(false)
      expect(fetch).toHaveBeenCalledTimes(20)
      expect(result.assets.size).toBe(19)
      expect(result.issues.get(`url:https://data.example/${ids[0]}.png`)).toBe('asset_probe_failed')
    } finally { sqlite.close() }
  })

  it('fails the whole publication when an optional asset exceeds the probe budget', async () => {
    const { sqlite, ids, env } = stacRouteFixture(40)
    try {
      for (const id of ids) sqlite.prepare('UPDATE datasets SET data_ref=? WHERE id=?').run(`url:https://data.example/${id}.png`, id)
      sqlite.prepare('UPDATE datasets SET color_table_ref=? WHERE id=?').run('url:https://data.example/colors.json', ids[39])
      const response = await onRequestGet(makeCtx({ env, url: 'https://node.example/api/v1/stac' }) as never)
      expect(response.status).toBe(503)
      expect(env.CATALOG_KV.put).not.toHaveBeenCalled()
      expect((await readStacPublication(env, { operatorReport: true })).publicationIssues).toEqual(['asset_probe_budget_exceeded'])
    } finally { sqlite.close() }
  })

  it('fails without caching when the build deadline expires during the final probe', async () => {
    const { sqlite, env } = stacRouteFixture()
    const deadline = new AbortController()
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => milliseconds === 15000 ? deadline.signal : timeout(milliseconds))
    vi.stubGlobal('fetch', vi.fn(async () => {
      deadline.abort()
      throw new Error('Deadline expired')
    }))
    try {
      const response = await onRequestGet(makeCtx({ env, url: 'https://node.example/api/v1/stac' }) as never)
      expect(response.status).toBe(503)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(env.CATALOG_KV.put).not.toHaveBeenCalled()
    } finally { spy.mockRestore(); sqlite.close() }
  })

  it.each(['prose', 'unreachable', 'available'])('distinguishes %s license evidence in the operator report', async mode => {
    const { sqlite, ids, env } = stacRouteFixture()
    const licenseUrl = 'https://data.example/license.txt'
    vi.stubGlobal('fetch', vi.fn(async (href: string) => href === licenseUrl
      ? new Response(null, { status: mode === 'unreachable' ? 404 : 200, headers: { 'Content-Type': 'text/plain' } })
      : new Response(null, { headers: { 'Content-Type': 'image/png' } })))
    try {
      sqlite.prepare('UPDATE datasets SET license_spdx=NULL, license_statement=?, license_url=?')
        .run('Use for education only', mode === 'prose' ? null : licenseUrl)
      const publication = await readStacPublication(env, { operatorReport: true })
      expect(publication.report[0]).toMatchObject({ id: ids[0], included: mode === 'available' })
      if (mode !== 'available') expect(publication.report[0].reasons)
        .toEqual([mode === 'prose' ? 'license_text_asset_pending' : 'license_asset_unresolved'])
      else expect(publication.products[0].collection!.links).toContainEqual(expect.objectContaining({ rel: 'license', href: licenseUrl }))
      expect(fetch).toHaveBeenCalledTimes(mode === 'prose' ? 1 : 2)
      expect(fetch).not.toHaveBeenCalledWith('Use for education only', expect.anything())
    } finally { sqlite.close() }
  })

  it('verifies and publishes a trusted colour-table asset', async () => {
    const { sqlite, ids, env } = stacRouteFixture()
    const href = 'https://data.example/colors.json'
    vi.stubGlobal('fetch', vi.fn(async (input: string) => new Response(null, {
      headers: { 'Content-Type': input === href ? 'application/json' : 'image/png' },
    })))
    try {
      sqlite.prepare('UPDATE datasets SET color_table_ref=?').run(`url:${href}`)
      const response = await onRequestGet(makeCtx({ env, url: `https://node.example/api/v1/stac/items/${ids[0]}` }) as never)
      expect(response.status).toBe(200)
      expect((await response.json() as StacItem).assets['color-table']).toMatchObject({ href, type: 'application/json' })
      expect(fetch).toHaveBeenCalledWith(href, expect.objectContaining({ method: 'HEAD', credentials: 'omit', redirect: 'manual' }))
      expect((await readStacPublication(env)).report[0].reasons).not.toContain('color-table_asset_unresolved')
    } finally { sqlite.close() }
  })

  it.each(['collections/missing', 'items/missing', 'collections/missing/items'])('returns no-store 404 for unsupported or missing %s', async path => {
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
        expect(result).toMatchObject({ ...document, links: expect.arrayContaining(document.links) })
        expect(result.links.every(link => new URL(link.href).protocol === 'https:')).toBe(true)
        expect(result.links.find(link => link.rel === 'self')?.href).toBe(self.href)
        expect(JSON.stringify(result)).not.toMatch(/spoof\.example/)
      }
      const product = publication.products[0]
      const alias = `https://node.example/api/v1/stac/collections/${product.collection!.id}/items/${product.item!.id}`
      expect(await (await onRequestGet(makeCtx({ env, url: alias }) as never)).json()).toEqual({ ...product.item,
        links: product.item!.links.map(link => link.rel === 'self' ? { ...link, href: alias } : link) })
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

  it.each(['limit=0', 'limit=-1', 'limit=1.5', 'limit=abc', 'cursor=unknown', 'bbox=0,0,1'])('rejects malformed/unsupported listing query %s', async query => {
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

  it('separates public and operator cache identities even with identical public rows', async () => {
    const { sqlite, env } = stacRouteFixture()
    const hash = vi.spyOn(snapshot, 'computeEtag')
    try {
      await readStacPublication(env)
      const publicSeed = hash.mock.calls[0][0]
      vi.mocked(env.CATALOG_KV.get).mockClear()
      vi.mocked(env.CATALOG_KV.put).mockClear()
      await readStacPublication(env, { operatorReport: true })
      const operatorSeed = hash.mock.calls[1][0]
      expect(JSON.parse(publicSeed).model).toEqual(JSON.parse(operatorSeed).model)
      expect(JSON.parse(publicSeed).operatorReport).toBe(false)
      expect(JSON.parse(operatorSeed).operatorReport).toBe(true)
      expect(await snapshot.computeEtag(publicSeed)).not.toBe(await snapshot.computeEtag(operatorSeed))
      expect(env.CATALOG_KV.get).not.toHaveBeenCalled()
      expect(env.CATALOG_KV.put).not.toHaveBeenCalled()
    } finally { hash.mockRestore(); sqlite.close() }
  })

  it('logs catalog failure reasons without exposing them in the public response', async () => {
    const { sqlite, env } = stacRouteFixture()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      sqlite.exec("UPDATE node_identity SET display_name=''")
      const response = await onRequestGet(makeCtx({ env, url: 'https://node.example/api/v1/stac' }) as never)
      expect(response.status).toBe(503)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual({ error: 'stac_unavailable' })
      expect(log).toHaveBeenCalledWith('[stac] publication failed', 'Invalid STAC catalog: node_identity_invalid')
      expect(env.CATALOG_KV.put).not.toHaveBeenCalled()
    } finally { log.mockRestore(); sqlite.close() }
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
      for (const response of [disabled, enabled]) {
        expect(response.headers.get('cache-control')).toBe('public, max-age=300, stale-while-revalidate=600')
      }
      const conditional = await discoveryGet(makeCtx({ env: { ...env, STAC_ENABLED: 'true' },
        headers: { 'if-none-match': enabled.headers.get('etag')! } }) as never)
      expect(conditional.status).toBe(304)
      expect(conditional.headers.get('link')).toBe(enabled.headers.get('link'))
      expect(conditional.headers.get('cache-control')).toBe(enabled.headers.get('cache-control'))
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