/**
 * Tests for the NHC CurrentStorms proxy (task: media suggestion
 * engine) — privileged gate, storm trimming, KV cache semantics, and
 * failure degradation. The upstream fetch is stubbed; the suite never
 * touches the network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { onRequestGet as stormsGet } from './nhc-storms'
import { makeKV } from '../../_lib/test-helpers'
import type { PublisherRow } from '../../_lib/publisher-store'

const ADMIN: PublisherRow = {
  id: 'PUB-ADMIN',
  email: 'admin@example.com',
  display_name: 'Admin',
  affiliation: null,
  org_id: null,
  role: 'admin',
  is_admin: 1,
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
}
const PUBLISHER: PublisherRow = { ...ADMIN, id: 'PUB-PUB', email: 'p@e', role: 'publisher', is_admin: 0 }

function ctx(opts: { env?: Record<string, unknown>; publisher?: PublisherRow } = {}) {
  const url = 'https://localhost/api/v1/publish/media/nhc-storms'
  return {
    request: new Request(url),
    env: opts.env ?? {},
    params: {},
    data: { publisher: opts.publisher ?? ADMIN },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: new URL(url).pathname,
  } as unknown as Parameters<typeof stormsGet>[0]
}

function stubUpstream(body: unknown, ok = true) {
  const fetchFn = vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response)
  vi.stubGlobal('fetch', fetchFn)
  return fetchFn
}

afterEach(() => {
  vi.unstubAllGlobals()
})

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

describe('GET /api/v1/publish/media/nhc-storms', () => {
  it('is 403 for a publisher-role account (no upstream request)', async () => {
    const fetchFn = stubUpstream({ activeStorms: [] })
    const res = await stormsGet(ctx({ publisher: PUBLISHER }))
    expect(res.status).toBe(403)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('trims storms to { id, name } and drops malformed entries', async () => {
    stubUpstream({
      activeStorms: [
        { id: 'al052026', name: 'Delta', classification: 'HU', intensity: '85', binNumber: 'AT1' },
        { id: 42, name: 'Bogus' }, // non-string id → dropped
        { name: 'NoId' },
      ],
    })
    const res = await stormsGet(ctx())
    expect(res.status).toBe(200)
    const { activeStorms } = await readJson<{ activeStorms: unknown[] }>(res)
    expect(activeStorms).toEqual([{ id: 'al052026', name: 'Delta' }])
  })

  it('caches real answers in KV and serves the cache without refetching', async () => {
    const fetchFn = stubUpstream({ activeStorms: [{ id: 'al052026', name: 'Delta' }] })
    const env = { CATALOG_KV: makeKV() }
    const first = await stormsGet(ctx({ env }))
    expect(first.headers.get('X-Cache')).toBe('MISS')
    const second = await stormsGet(ctx({ env }))
    expect(second.headers.get('X-Cache')).toBe('HIT')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('degrades to an empty list on upstream failure — and does not cache it', async () => {
    const boom = vi.fn(async () => {
      throw new Error('offline')
    })
    vi.stubGlobal('fetch', boom)
    const env = { CATALOG_KV: makeKV() }
    const res = await stormsGet(ctx({ env }))
    expect(res.status).toBe(200)
    expect(await readJson<{ activeStorms: unknown[] }>(res)).toEqual({ activeStorms: [] })
    // Next call goes back upstream rather than serving a pinned outage.
    const again = await stormsGet(ctx({ env }))
    expect(again.headers.get('X-Cache')).toBe('MISS')
    expect(boom).toHaveBeenCalledTimes(2)
  })
})
