/**
 * Tests for the node-mode catalog fetch path in `dataService.ts`.
 *
 * Coverage:
 *   - VITE_CATALOG_SOURCE=node hits `/api/v1/catalog`, maps wire
 *     fields to the Dataset shape, and injects the local sample
 *     tours.
 *   - The supported-format filter and weight-DESC sort apply.
 *   - Hidden / HIDDEN_TOUR_IDS rows are filtered out.
 *   - A non-2xx response surfaces as a thrown error.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DataService } from './dataService'

const ORIGINAL_SOURCE = import.meta.env.VITE_CATALOG_SOURCE

function mockNodeCatalog(datasets: unknown[], tours: unknown[] = []) {
  return vi.fn(async (input: RequestInfo | URL | string) => {
    const url = String(input)
    if (url === '/api/v1/catalog') {
      return new Response(JSON.stringify({ datasets }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url === '/api/v1/tours') {
      return new Response(JSON.stringify({ tours }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    throw new Error(`Unexpected fetch URL: ${url}`)
  }) as unknown as typeof fetch
}

describe('DataService — node-mode', () => {
  beforeEach(() => {
    ;(import.meta.env as Record<string, string>).VITE_CATALOG_SOURCE = 'node'
  })

  afterEach(() => {
    if (ORIGINAL_SOURCE === undefined) {
      delete (import.meta.env as Record<string, string>).VITE_CATALOG_SOURCE
    } else {
      ;(import.meta.env as Record<string, string>).VITE_CATALOG_SOURCE = ORIGINAL_SOURCE
    }
    vi.unstubAllGlobals()
  })

  it('fetches /api/v1/catalog and maps the wire shape into Dataset', async () => {
    vi.stubGlobal(
      'fetch',
      mockNodeCatalog([
        {
          id: 'DS001',
          title: 'Hurricane Helene 2024',
          format: 'video/mp4',
          dataLink: '/api/v1/datasets/DS001/manifest',
          organization: 'NOAA',
          weight: 100,
          enriched: { categories: { Theme: ['Atmosphere'] }, keywords: ['hurricane'] },
        },
        {
          id: 'DS002',
          title: 'Nighttime Lights',
          format: 'image/jpg',
          dataLink: '/api/v1/datasets/DS002/manifest',
          weight: 50,
        },
      ]),
    )
    const svc = new DataService()
    const datasets = await svc.fetchDatasets()

    // Two real datasets + two sample tours.
    expect(datasets).toHaveLength(4)

    const helene = datasets.find(d => d.id === 'DS001')!
    expect(helene.title).toBe('Hurricane Helene 2024')
    expect(helene.format).toBe('video/mp4')
    expect(helene.dataLink).toBe('/api/v1/datasets/DS001/manifest')
    expect(helene.organization).toBe('NOAA')
    expect(helene.enriched?.categories?.Theme).toEqual(['Atmosphere'])

    // Weight-descending sort puts the higher-weighted item first.
    expect(datasets[0].id).toBe('DS001')
  })

  it('injects the built-in sample tours so they show up in browse', async () => {
    vi.stubGlobal('fetch', mockNodeCatalog([]))
    const svc = new DataService()
    const datasets = await svc.fetchDatasets()
    const ids = datasets.map(d => d.id)
    expect(ids).toContain('SAMPLE_TOUR')
    expect(ids).toContain('SAMPLE_TOUR_CLIMATE_FUTURES')
  })

  it('merges publisher tours from /api/v1/tours into the dataset list', async () => {
    vi.stubGlobal(
      'fetch',
      mockNodeCatalog(
        [],
        [
          {
            id: '01HXPUB000000000000000001',
            slug: 'hurricane-tour',
            title: 'Hurricane Tour',
            description: 'A guided look at hurricane formation.',
            tour_json_url: 'https://r2.example.com/tours/01HX/published/01HY.json',
            thumbnail_url: 'https://r2.example.com/tours/01HX/thumb.jpg',
            visibility: 'public',
            schema_version: 1,
            created_at: '2026-05-01T00:00:00.000Z',
            updated_at: '2026-05-01T00:00:00.000Z',
            published_at: '2026-05-01T00:00:00.000Z',
            origin_node: 'NODE000',
          },
        ],
      ),
    )
    const svc = new DataService()
    const datasets = await svc.fetchDatasets()
    const tour = datasets.find(d => d.id === '01HXPUB000000000000000001')
    expect(tour).toBeDefined()
    expect(tour!.format).toBe('tour/json')
    expect(tour!.title).toBe('Hurricane Tour')
    expect(tour!.tourJsonUrl).toBe(
      'https://r2.example.com/tours/01HX/published/01HY.json',
    )
    expect(tour!.tags).toEqual(['Tours'])
  })

  it('tolerates a tours-endpoint failure and still returns datasets', async () => {
    const fetchStub = vi.fn(async (input: RequestInfo | URL | string) => {
      const url = String(input)
      if (url === '/api/v1/catalog') {
        return new Response(JSON.stringify({ datasets: [] }), { status: 200 })
      }
      if (url === '/api/v1/tours') {
        return new Response('boom', { status: 500 })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchStub)
    const svc = new DataService()
    // No throw — the dataset path is intact even though tours
    // failed. Sample tours still injected.
    const datasets = await svc.fetchDatasets()
    expect(datasets.map(d => d.id)).toContain('SAMPLE_TOUR')
  })

  it('filters hidden datasets and HIDDEN_TOUR_IDS', async () => {
    vi.stubGlobal(
      'fetch',
      mockNodeCatalog([
        {
          id: 'INTERNAL_SOS_687', // in HIDDEN_TOUR_IDS
          title: '360 Media',
          format: 'tour/json',
          dataLink: '/api/v1/datasets/INTERNAL_SOS_687/manifest',
        },
        {
          id: 'HIDDEN1',
          title: 'Hidden one',
          format: 'video/mp4',
          dataLink: '/api/v1/datasets/HIDDEN1/manifest',
          isHidden: true,
        },
        {
          id: 'BAD_FORMAT',
          title: 'Unsupported',
          format: 'audio/mpeg', // not supported
          dataLink: '/api/v1/datasets/BAD_FORMAT/manifest',
        },
      ]),
    )
    const svc = new DataService()
    const datasets = await svc.fetchDatasets()
    // Only the sample tours survive the filter.
    expect(datasets.map(d => d.id).sort()).toEqual(
      ['SAMPLE_TOUR', 'SAMPLE_TOUR_CLIMATE_FUTURES'].sort(),
    )
  })

  it('throws on a non-2xx response from the backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 503 })) as unknown as typeof fetch,
    )
    const svc = new DataService()
    await expect(svc.fetchDatasets()).rejects.toThrow(/Failed to fetch datasets/)
  })

  it('caches across calls so a second fetch does not re-hit the backend', async () => {
    const fetchStub = mockNodeCatalog([
      {
        id: 'DS001',
        title: 'One',
        format: 'video/mp4',
        dataLink: '/api/v1/datasets/DS001/manifest',
      },
    ])
    vi.stubGlobal('fetch', fetchStub)
    const svc = new DataService()
    await svc.fetchDatasets()
    await svc.fetchDatasets()
    // Phase 3pt/G follow-up — node mode now hits two endpoints
    // per fetch (catalog + tours). The cache wraps the merged
    // result so the second fetchDatasets should re-hit neither.
    expect(fetchStub).toHaveBeenCalledTimes(2)
    expect(fetchStub).toHaveBeenNthCalledWith(1, '/api/v1/catalog', expect.anything())
    expect(fetchStub).toHaveBeenNthCalledWith(2, '/api/v1/tours', expect.anything())
  })

  it('preserves legacyId from the wire shape and falls back on lookup (1d/T)', async () => {
    // Tour files and other long-lived references hard-code SOS
    // legacy IDs (e.g. INTERNAL_SOS_768); post-cutover the catalog's
    // primary `id` is a ULID. The dataService maps the wire
    // `legacyId` field through and `getDatasetById` consults it as
    // a fallback so tours keep resolving without rewrites.
    vi.stubGlobal(
      'fetch',
      mockNodeCatalog([
        {
          id: '01KQFFCEE4Q7NQGJNFB0Z042MC',
          legacyId: 'INTERNAL_SOS_768',
          title: 'Hurricane Season - 2024',
          format: 'video/mp4',
          dataLink: '/api/v1/datasets/01KQFFCEE4Q7NQGJNFB0Z042MC/manifest',
        },
      ]),
    )
    const svc = new DataService()
    const datasets = await svc.fetchDatasets()
    const hurricane = datasets.find(d => d.id === '01KQFFCEE4Q7NQGJNFB0Z042MC')
    expect(hurricane?.legacyId).toBe('INTERNAL_SOS_768')

    // Direct ULID lookup still works.
    expect(svc.getDatasetById('01KQFFCEE4Q7NQGJNFB0Z042MC')?.id).toBe(
      '01KQFFCEE4Q7NQGJNFB0Z042MC',
    )
    // Legacy-ID lookup resolves to the same row via the fallback.
    expect(svc.getDatasetById('INTERNAL_SOS_768')?.id).toBe(
      '01KQFFCEE4Q7NQGJNFB0Z042MC',
    )
    // Unknown id still misses.
    expect(svc.getDatasetById('NONEXISTENT')).toBeUndefined()
  })
})
