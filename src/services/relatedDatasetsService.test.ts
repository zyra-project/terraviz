import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchSemanticRelatedIds } from './relatedDatasetsService'

function mockFetch(spec: { ok?: boolean; status?: number; body?: unknown; reject?: unknown }) {
  return vi.fn(async (..._args: unknown[]) => {
    if (spec.reject !== undefined) throw spec.reject
    const status = spec.status ?? (spec.ok === false ? 500 : 200)
    return {
      ok: spec.ok ?? (status >= 200 && status < 300),
      status,
      json: async () => spec.body ?? {},
    } as unknown as Response
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchSemanticRelatedIds', () => {
  it('returns the ordered neighbour ids on success', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({ body: { datasets: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] } }),
    )
    expect(await fetchSemanticRelatedIds('SEED')).toEqual(['A', 'B', 'C'])
  })

  it('requests the dataset-scoped endpoint with the limit', async () => {
    const fetchFn = mockFetch({ body: { datasets: [{ id: 'A' }] } })
    vi.stubGlobal('fetch', fetchFn)
    await fetchSemanticRelatedIds('DS 1', 3)
    const url = String(fetchFn.mock.calls[0][0])
    expect(url).toContain('/api/v1/datasets/DS%201/related')
    expect(url).toContain('limit=3')
  })

  it('returns null when the backend is degraded (keep lexical fallback)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({ body: { datasets: [], degraded: 'unconfigured' } }),
    )
    expect(await fetchSemanticRelatedIds('SEED')).toBeNull()
  })

  it('returns null on a non-OK response', async () => {
    vi.stubGlobal('fetch', mockFetch({ ok: false, status: 503 }))
    expect(await fetchSemanticRelatedIds('SEED')).toBeNull()
  })

  it('returns null on an empty neighbour set', async () => {
    vi.stubGlobal('fetch', mockFetch({ body: { datasets: [] } }))
    expect(await fetchSemanticRelatedIds('SEED')).toBeNull()
  })

  it('returns null on a malformed body', async () => {
    vi.stubGlobal('fetch', mockFetch({ body: { nope: true } }))
    expect(await fetchSemanticRelatedIds('SEED')).toBeNull()
  })

  it('returns null (not throw) on a network error', async () => {
    vi.stubGlobal('fetch', mockFetch({ reject: new Error('offline') }))
    expect(await fetchSemanticRelatedIds('SEED')).toBeNull()
  })

  it('filters out non-string / empty ids', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({ body: { datasets: [{ id: 'A' }, { id: 7 }, { id: '' }, { nope: 1 }, { id: 'B' }] } }),
    )
    expect(await fetchSemanticRelatedIds('SEED')).toEqual(['A', 'B'])
  })
})
