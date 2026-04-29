/**
 * Tests for the single-dataset read endpoint.
 *
 * Coverage:
 *   - Healthy path: 200 with the expected wire shape.
 *   - 404 for an unknown id.
 *   - 404 for a hidden / retracted / non-public id (visibility
 *     filter parity with the list endpoint).
 *   - 503 when CATALOG_DB is missing.
 *   - 503 when node_identity has not been provisioned.
 *   - 304 with `If-None-Match`.
 */

import { describe, it, expect } from 'vitest'
import { onRequestGet } from './[id]'
import { asD1, makeCtx, makeKV, seedFixtures } from '../_lib/test-helpers'

interface WireBody {
  id: string
  title: string
  dataLink: string
  originNode: string
  visibility: string
  schemaVersion: number
  enriched?: unknown
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

describe('GET /api/v1/datasets/{id}', () => {
  it('returns 503 when CATALOG_DB is not bound', async () => {
    const ctx = makeCtx<'id'>({ env: {}, params: { id: 'whatever' } })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(503)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toBe('binding_missing')
  })

  it('returns 503 when node_identity has not been provisioned', async () => {
    const sqlite = seedFixtures({ count: 1 })
    sqlite.prepare('DELETE FROM node_identity').run()
    const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() }
    const ctx = makeCtx<'id'>({ env, params: { id: 'DS000AAAAAAAAAAAAAAAAAAAAA' } })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(503)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toBe('identity_missing')
  })

  it('returns 404 for an unknown dataset id', async () => {
    const sqlite = seedFixtures({ count: 1 })
    const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() }
    const ctx = makeCtx<'id'>({ env, params: { id: 'NOPE' } })
    const res = await onRequestGet(ctx)
    expect(res.status).toBe(404)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toBe('not_found')
  })

  it('returns 404 for a hidden, retracted, or non-public dataset', async () => {
    const sqlite = seedFixtures({ count: 3 })
    sqlite.prepare(`UPDATE datasets SET is_hidden = 1 WHERE slug = 'dataset-0'`).run()
    sqlite
      .prepare(
        `UPDATE datasets SET retracted_at = '2026-02-01T00:00:00.000Z' WHERE slug = 'dataset-1'`,
      )
      .run()
    sqlite.prepare(`UPDATE datasets SET visibility = 'private' WHERE slug = 'dataset-2'`).run()
    const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() }

    for (const id of [
      'DS000AAAAAAAAAAAAAAAAAAAAA',
      'DS001AAAAAAAAAAAAAAAAAAAAA',
      'DS002AAAAAAAAAAAAAAAAAAAAA',
    ]) {
      const res = await onRequestGet(makeCtx<'id'>({ env, params: { id } }))
      expect(res.status).toBe(404)
    }
  })

  it('returns the wire shape for a known dataset', async () => {
    const sqlite = seedFixtures({ count: 2 })
    const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() }
    const id = 'DS001AAAAAAAAAAAAAAAAAAAAA'
    const res = await onRequestGet(makeCtx<'id'>({ env, params: { id } }))
    expect(res.status).toBe(200)
    const body = await readJson<WireBody>(res)
    expect(body.id).toBe(id)
    expect(body.title).toBe('Test Dataset 1')
    expect(body.dataLink).toBe(`/api/v1/datasets/${id}/manifest`)
    expect(body.originNode).toBe('NODE000')
    expect(body.visibility).toBe('public')
    expect(body.schemaVersion).toBe(1)
    expect(body.enriched).toBeDefined()
  })

  it('returns 304 with matching If-None-Match', async () => {
    const sqlite = seedFixtures({ count: 1 })
    const env = { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() }
    const id = 'DS000AAAAAAAAAAAAAAAAAAAAA'

    const first = await onRequestGet(makeCtx<'id'>({ env, params: { id } }))
    const etag = first.headers.get('etag')!
    expect(etag).toBeTruthy()

    const second = await onRequestGet(
      makeCtx<'id'>({ env, params: { id }, headers: { 'if-none-match': etag } }),
    )
    expect(second.status).toBe(304)
    expect(second.headers.get('etag')).toBe(etag)
  })
})
