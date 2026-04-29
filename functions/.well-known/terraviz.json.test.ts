/**
 * Tests for /.well-known/terraviz.json.
 *
 * Coverage:
 *   - 503 when CATALOG_DB is missing.
 *   - 503 when node_identity has not been provisioned.
 *   - 200 with the documented wire shape — keys, endpoint paths,
 *     `schema_versions_supported`, `policy` defaults — sourced from
 *     the row inserted by the seed (or eventually `gen:node-key`).
 *   - ETag in the response header.
 *   - 304 with matching `If-None-Match`.
 */

import { describe, expect, it } from 'vitest'
import { onRequestGet } from './terraviz.json'
import {
  asD1,
  makeCtx,
  makeKV,
  seedFixtures,
} from '../api/v1/_lib/test-helpers'

interface WellKnownBody {
  node_id: string
  display_name: string
  base_url: string
  public_key: string
  schema_versions_supported: number[]
  endpoints: { catalog: string; feed: string; handshake: string }
  policy: {
    open_subscription: boolean
    auto_approve: boolean
    max_request_rate_per_minute: number
  }
  contact: string | null
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

describe('GET /.well-known/terraviz.json', () => {
  it('returns 503 when CATALOG_DB is not bound', async () => {
    const ctx = makeCtx({ env: {} })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(503)
    expect((await readJson<{ error: string }>(res)).error).toBe('binding_missing')
  })

  it('returns 503 when node_identity has not been provisioned', async () => {
    const sqlite = seedFixtures({ count: 0 })
    sqlite.prepare('DELETE FROM node_identity').run()
    const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() }
    const res = await onRequestGet(makeCtx({ env }))
    expect(res.status).toBe(503)
    const body = await readJson<{ error: string; message: string }>(res)
    expect(body.error).toBe('identity_missing')
    expect(body.message).toContain('gen:node-key')
  })

  it('serves the documented wire shape from the seeded node identity', async () => {
    const sqlite = seedFixtures({ count: 0, baseUrl: 'https://node.test' })
    const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() }
    const res = await onRequestGet(makeCtx({ env }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    expect(res.headers.get('etag')).toMatch(/^".+"$/)
    expect(res.headers.get('cache-control')).toContain('max-age=300')

    const body = await readJson<WellKnownBody>(res)
    expect(body.node_id).toBe('NODE000')
    expect(body.display_name).toBe('Test Node')
    expect(body.base_url).toBe('https://node.test')
    expect(body.public_key).toBe('ed25519:test')
    expect(body.schema_versions_supported).toEqual([1])
    expect(body.endpoints).toEqual({
      catalog: '/api/v1/catalog',
      feed: '/api/v1/federation/feed',
      handshake: '/api/v1/federation/handshake',
    })
    expect(body.policy).toEqual({
      open_subscription: false,
      auto_approve: false,
      max_request_rate_per_minute: 600,
    })
  })

  it('returns 304 with matching If-None-Match', async () => {
    const sqlite = seedFixtures({ count: 0 })
    const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() }

    const first = await onRequestGet(makeCtx({ env }))
    const etag = first.headers.get('etag')!
    expect(etag).toBeTruthy()

    const second = await onRequestGet(
      makeCtx({ env, headers: { 'if-none-match': etag } }),
    )
    expect(second.status).toBe(304)
    expect(second.headers.get('etag')).toBe(etag)
  })
})
