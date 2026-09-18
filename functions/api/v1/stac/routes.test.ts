// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { onRequestGet } from './[[path]]'
import { asD1, makeCtx, makeKV, seedFixtures } from '../_lib/test-helpers'
import { onRequestGet as schemaGet } from '../../../schema/stac/terraviz/v1.0.0/schema.json'
import { onRequestGet as discoveryGet } from '../../../.well-known/terraviz.json'
import schema from '../../../../docs/metadata/schemas/terraviz-v1.0.0.json'

describe('STAC public routes', () => {
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