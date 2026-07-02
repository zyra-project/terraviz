import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  sanitizePublicEvent,
  fetchApprovedEvents,
  fetchEventsForDataset,
  resetEventsCacheForTests,
  resetDatasetEventsCacheForTests,
} from './eventsService'

const VALID = {
  id: 'E1',
  title: 'Hurricane Lena',
  source: { name: 'NOAA', url: 'https://example.gov/storm', publishedAt: '2026-06-25T00:00:00Z' },
  occurredStart: '2026-06-25T12:00:00Z',
  geometry: { point: { lat: 29, lon: -89 } },
  datasetIds: ['DS0'],
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetEventsCacheForTests()
  resetDatasetEventsCacheForTests()
})

describe('sanitizePublicEvent', () => {
  it('accepts a well-formed event', () => {
    const e = sanitizePublicEvent(VALID)!
    expect(e.id).toBe('E1')
    expect(e.geometry.point).toEqual({ lat: 29, lon: -89 })
    expect(e.datasetIds).toEqual(['DS0'])
    expect(e.source.publishedAt).toBe('2026-06-25T00:00:00Z')
  })

  it('rejects a non-http(s) source url (XSS defense)', () => {
    expect(sanitizePublicEvent({ ...VALID, source: { name: 'X', url: 'javascript:alert(1)' } })).toBeNull()
  })

  it('rejects an event with no dataset ids (nothing to click through to)', () => {
    expect(sanitizePublicEvent({ ...VALID, datasetIds: [] })).toBeNull()
  })

  it('coerces a bbox geometry and drops a malformed one', () => {
    const ok = sanitizePublicEvent({ ...VALID, geometry: { boundingBox: { n: 1, s: 0, w: 0, e: 1 } } })!
    expect(ok.geometry.boundingBox).toEqual({ n: 1, s: 0, w: 0, e: 1 })
    const bad = sanitizePublicEvent({ ...VALID, geometry: { boundingBox: { n: 'x' } } })!
    expect(bad.geometry.boundingBox).toBeUndefined()
  })
})

function stubFetch(value: unknown, ok = true): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok, json: async () => value }))
}

describe('fetchApprovedEvents', () => {
  it('returns the sanitized list, dropping bad-url events', async () => {
    stubFetch({ events: [VALID, { ...VALID, id: 'E2', source: { name: 'X', url: 'data:text/html,x' } }] })
    const events = await fetchApprovedEvents()
    expect(events.map(e => e.id)).toEqual(['E1'])
  })

  it('returns [] on a non-ok response', async () => {
    stubFetch(null, false)
    expect(await fetchApprovedEvents()).toEqual([])
  })

  it('serves the in-memory cache on a second call', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ events: [VALID] }) })
    vi.stubGlobal('fetch', fetchMock)
    await fetchApprovedEvents()
    await fetchApprovedEvents()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('fetchEventsForDataset', () => {
  it('fetches the per-dataset endpoint and sanitizes', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ events: [VALID] }) })
    vi.stubGlobal('fetch', fetchMock)
    const events = await fetchEventsForDataset('DS0')
    expect(events.map(e => e.id)).toEqual(['E1'])
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v1/datasets/DS0/events')
  })

  it('returns [] on a non-ok response', async () => {
    stubFetch(null, false)
    expect(await fetchEventsForDataset('DS0')).toEqual([])
  })

  it('caches per dataset id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ events: [VALID] }) })
    vi.stubGlobal('fetch', fetchMock)
    await fetchEventsForDataset('DS0')
    await fetchEventsForDataset('DS0') // cached
    await fetchEventsForDataset('DS1') // different id → refetch
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
