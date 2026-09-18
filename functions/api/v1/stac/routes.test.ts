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

describe('STAC public routes', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'Content-Type': 'image/png' } }))))
  afterEach(() => vi.unstubAllGlobals())

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