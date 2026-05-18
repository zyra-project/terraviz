/**
 * Tests for the `?preview=` SPA consumer entry points on
 * `DataService`: `fetchPreviewDataset` and `injectDataset`.
 *
 * Coverage:
 *   - Happy path: fetch returns wire shape, mapper produces a
 *     valid Dataset, dataLink survives the token-gated rewrite.
 *   - Typed `PreviewFetchError` codes for 401/404/503 envelopes.
 *   - `injectDataset` adds a fresh row to an empty cache, replaces
 *     an existing row by id, and prepends a new row to a populated
 *     cache.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { DataService, PreviewFetchError } from './dataService'

const ID = 'DS000AAAAAAAAAAAAAAAAAAAAA'
const TOKEN = 'tok.sig'

function mockOkPreview(extra: Record<string, unknown> = {}) {
  return vi.fn(async (input: RequestInfo | URL | string) => {
    expect(String(input)).toBe(`/api/v1/datasets/${ID}/preview/${TOKEN}`)
    return new Response(
      JSON.stringify({
        dataset: {
          id: ID,
          slug: 'draft-clip',
          title: 'Draft Clip',
          format: 'video/mp4',
          dataLink: `/api/v1/datasets/${ID}/preview/${TOKEN}/manifest`,
          abstractTxt: 'A draft awaiting review.',
          originNode: 'NODE000',
          originNodeUrl: 'https://example.test',
          originDisplayName: 'Test Node',
          visibility: 'private',
          schemaVersion: 1,
          createdAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:00.000Z',
          ...extra,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as typeof fetch
}

function mockErrorResponse(status: number, error: string, message: string) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ error, message }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  ) as unknown as typeof fetch
}

describe('DataService.fetchPreviewDataset', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('maps the wire shape into a Dataset with the token-gated dataLink', async () => {
    vi.stubGlobal('fetch', mockOkPreview())
    const svc = new DataService()
    const ds = await svc.fetchPreviewDataset(ID, TOKEN)
    expect(ds.id).toBe(ID)
    expect(ds.title).toBe('Draft Clip')
    expect(ds.format).toBe('video/mp4')
    expect(ds.dataLink).toBe(`/api/v1/datasets/${ID}/preview/${TOKEN}/manifest`)
    expect(ds.abstractTxt).toBe('A draft awaiting review.')
  })

  it('throws PreviewFetchError(invalid_token) on a 401 envelope', async () => {
    vi.stubGlobal(
      'fetch',
      mockErrorResponse(401, 'invalid_token', 'Preview token is invalid or expired.'),
    )
    const svc = new DataService()
    await expect(svc.fetchPreviewDataset(ID, TOKEN)).rejects.toMatchObject({
      name: 'PreviewFetchError',
      code: 'invalid_token',
    })
  })

  it('throws PreviewFetchError(not_found) on a 404 envelope', async () => {
    vi.stubGlobal(
      'fetch',
      mockErrorResponse(404, 'not_found', `Dataset ${ID} not found.`),
    )
    const svc = new DataService()
    await expect(svc.fetchPreviewDataset(ID, TOKEN)).rejects.toBeInstanceOf(
      PreviewFetchError,
    )
  })

  it('throws PreviewFetchError(preview_unconfigured) on a 503 envelope', async () => {
    vi.stubGlobal(
      'fetch',
      mockErrorResponse(
        503,
        'preview_unconfigured',
        'Preview tokens are not configured on this deployment.',
      ),
    )
    const svc = new DataService()
    await expect(svc.fetchPreviewDataset(ID, TOKEN)).rejects.toMatchObject({
      code: 'preview_unconfigured',
    })
  })

  it('falls back to http_<status> when the body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('garbage', { status: 502 })) as unknown as typeof fetch,
    )
    const svc = new DataService()
    await expect(svc.fetchPreviewDataset(ID, TOKEN)).rejects.toMatchObject({
      code: 'http_502',
    })
  })

  it('normalises legacy image/jpg → image/jpeg on the way in', async () => {
    vi.stubGlobal('fetch', mockOkPreview({ format: 'image/jpg' }))
    const svc = new DataService()
    const ds = await svc.fetchPreviewDataset(ID, TOKEN)
    expect(ds.format).toBe('image/jpeg')
  })
})

describe('DataService.injectDataset', () => {
  function fixture(id: string, weight = 0) {
    return {
      id,
      title: `Dataset ${id}`,
      format: 'video/mp4' as const,
      dataLink: `/x/${id}`,
      weight,
    }
  }

  it('initialises the cache when it is empty', () => {
    const svc = new DataService()
    svc.injectDataset(fixture('DS_X'))
    expect(svc.getDatasetById('DS_X')?.id).toBe('DS_X')
  })

  it('prepends a new dataset to a populated cache', async () => {
    vi.stubGlobal('fetch', mockOkPreview())
    const svc = new DataService()
    await svc.fetchPreviewDataset(ID, TOKEN).then(d => svc.injectDataset(d))
    svc.injectDataset(fixture('DS_Y'))
    // The most recently injected item lands at the head — gives the
    // boot path a deterministic place to find it without scanning.
    expect(svc.getDatasetById('DS_Y')?.id).toBe('DS_Y')
    expect(svc.getDatasetById(ID)?.id).toBe(ID)
    vi.unstubAllGlobals()
  })

  it('replaces an existing dataset with the same id', () => {
    const svc = new DataService()
    svc.injectDataset(fixture('DS_Z', 1))
    svc.injectDataset(fixture('DS_Z', 99))
    expect(svc.getDatasetById('DS_Z')?.weight).toBe(99)
  })

  it('does not mutate the array returned by a prior fetchDatasets call', async () => {
    // main.ts:loadDatasets does `appState.datasets = await fetchDatasets()`
    // and treats that array as the public-catalog snapshot. If
    // injectDataset mutated `cache.datasets` in-place, the draft
    // would leak into the snapshot and surface in the browse panel.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            datasets: [
              {
                id: 'PUB1',
                title: 'Published 1',
                format: 'video/mp4',
                dataLink: '/x/PUB1',
                weight: 10,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ) as unknown as typeof fetch,
    )
    const svc = new DataService()
    const snapshot = await svc.fetchDatasets()
    const beforeLen = snapshot.length
    svc.injectDataset(fixture('DRAFT', 99))
    expect(snapshot.length).toBe(beforeLen)
    expect(snapshot.some(d => d.id === 'DRAFT')).toBe(false)
    // And the cache itself still finds the injected row.
    expect(svc.getDatasetById('DRAFT')?.id).toBe('DRAFT')
    vi.unstubAllGlobals()
  })
})
