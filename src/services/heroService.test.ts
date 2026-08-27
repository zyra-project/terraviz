// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  getHeroCandidate,
  pickAutoDerived,
  sanitizeOverride,
  windowIsActive,
  resetHeroCacheForTests,
  AUTO_DERIVE_WINDOW_MS,
  REAL_TIME_TAG,
} from './heroService'
import type { Dataset } from '../types'

const NOW = Date.parse('2026-06-01T12:00:00.000Z')

function ds(id: string, opts: { tags?: string[]; endTime?: string; isHidden?: boolean } = {}): Dataset {
  return {
    id,
    title: id,
    dataLink: '',
    tags: opts.tags,
    endTime: opts.endTime,
    isHidden: opts.isHidden,
  } as unknown as Dataset
}

/** Stub global fetch to return the given override JSON (or a failure).
 *  Uses vi.stubGlobal so vi.unstubAllGlobals() in afterEach removes it
 *  and it can't leak into other test files. */
function stubFetch(value: unknown, ok = true): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok,
    json: async () => value,
  }))
}

beforeEach(() => {
  resetHeroCacheForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetHeroCacheForTests()
})

describe('windowIsActive', () => {
  it('is true inside [start, end]', () => {
    expect(windowIsActive({ start: '2026-05-01', end: '2026-07-01' }, NOW)).toBe(true)
  })
  it('is false before start and after end', () => {
    expect(windowIsActive({ start: '2026-07-01', end: '2026-08-01' }, NOW)).toBe(false)
    expect(windowIsActive({ start: '2026-01-01', end: '2026-02-01' }, NOW)).toBe(false)
  })
  it('fails closed for a missing or unparseable window', () => {
    expect(windowIsActive(undefined, NOW)).toBe(false)
    expect(windowIsActive({ start: 'nope', end: '2026-07-01' }, NOW)).toBe(false)
  })
})

describe('sanitizeOverride', () => {
  it('returns null for the empty stub', () => {
    expect(sanitizeOverride({})).toBeNull()
  })
  it('returns null without a mandatory window', () => {
    expect(sanitizeOverride({ datasetId: 'a' })).toBeNull()
    expect(sanitizeOverride({ datasetId: 'a', window: { start: '2026-01-01' } })).toBeNull()
  })
  it('parses a valid override with optional headline', () => {
    expect(
      sanitizeOverride({ datasetId: 'a', window: { start: '2026-01-01', end: '2026-02-01' }, headline: 'Hi' }),
    ).toEqual({ datasetId: 'a', window: { start: '2026-01-01', end: '2026-02-01' }, headline: 'Hi' })
  })
})

describe('pickAutoDerived', () => {
  it('picks a real-time dataset whose endTime is within 24h', () => {
    const recent = new Date(NOW - 60 * 60 * 1000).toISOString() // 1h ago
    const cat = [ds('a', { tags: [REAL_TIME_TAG], endTime: recent })]
    expect(pickAutoDerived(cat, NOW)?.id).toBe('a')
  })

  it('ignores real-time datasets older than 24h', () => {
    const old = new Date(NOW - AUTO_DERIVE_WINDOW_MS - 1000).toISOString()
    const cat = [ds('a', { tags: [REAL_TIME_TAG], endTime: old })]
    expect(pickAutoDerived(cat, NOW)).toBeNull()
  })

  it('ignores datasets without the Real-Time tag', () => {
    const recent = new Date(NOW - 1000).toISOString()
    const cat = [ds('a', { tags: ['Water'], endTime: recent })]
    expect(pickAutoDerived(cat, NOW)).toBeNull()
  })

  it('skips hidden rows and rows without a parseable endTime', () => {
    const recent = new Date(NOW - 1000).toISOString()
    const cat = [
      ds('hidden', { tags: [REAL_TIME_TAG], endTime: recent, isHidden: true }),
      ds('undated', { tags: [REAL_TIME_TAG] }),
    ]
    expect(pickAutoDerived(cat, NOW)).toBeNull()
  })

  it('returns the freshest of several eligible datasets', () => {
    const cat = [
      ds('older', { tags: [REAL_TIME_TAG], endTime: new Date(NOW - 5 * 60 * 60 * 1000).toISOString() }),
      ds('newer', { tags: [REAL_TIME_TAG], endTime: new Date(NOW - 30 * 60 * 1000).toISOString() }),
    ]
    expect(pickAutoDerived(cat, NOW)?.id).toBe('newer')
  })
})

describe('getHeroCandidate', () => {
  const recent = new Date(NOW - 60 * 60 * 1000).toISOString()
  const realtime = ds('rt', { tags: [REAL_TIME_TAG], endTime: recent })

  it('returns the override when it is in-window and resolves', async () => {
    stubFetch({ datasetId: 'feat', window: { start: '2026-05-01', end: '2026-07-01' }, headline: 'Big storm' })
    const cat = [ds('feat'), realtime]
    const res = await getHeroCandidate(cat, { now: NOW })
    expect(res).toMatchObject({ source: 'override', headline: 'Big storm' })
    expect(res?.dataset.id).toBe('feat')
  })

  it('falls through to auto-derived when the override window expired', async () => {
    stubFetch({ datasetId: 'feat', window: { start: '2026-01-01', end: '2026-02-01' } })
    const cat = [ds('feat'), realtime]
    const res = await getHeroCandidate(cat, { now: NOW })
    expect(res).toMatchObject({ source: 'auto' })
    expect(res?.dataset.id).toBe('rt')
  })

  it('falls through to auto-derived when the override datasetId is missing/hidden', async () => {
    stubFetch({ datasetId: 'ghost', window: { start: '2026-05-01', end: '2026-07-01' } })
    const cat = [realtime]
    const res = await getHeroCandidate(cat, { now: NOW })
    expect(res?.dataset.id).toBe('rt')
    expect(res?.source).toBe('auto')
  })

  it('returns null when nothing qualifies (empty stub + no real-time)', async () => {
    stubFetch({})
    const cat = [ds('plain', { tags: ['Water'] })]
    expect(await getHeroCandidate(cat, { now: NOW })).toBeNull()
  })

  it('falls through to auto-derived when the override fetch fails', async () => {
    stubFetch(null, false) // non-ok response
    const cat = [realtime]
    const res = await getHeroCandidate(cat, { now: NOW })
    expect(res?.dataset.id).toBe('rt')
  })
})

describe('getHeroCandidate — backend read-through', () => {
  const recent = new Date(NOW - 60 * 60 * 1000).toISOString()
  const realtime = ds('rt', { tags: [REAL_TIME_TAG], endTime: recent })
  const activeWindow = { start: '2026-05-01', end: '2026-07-01' }
  const expiredWindow = { start: '2026-01-01', end: '2026-02-01' }

  /** Route fetch by URL so the backend endpoint and the static file
   *  can return different payloads. */
  function stubRouted(routes: {
    backend?: { ok?: boolean; body?: unknown }
    file?: { ok?: boolean; body?: unknown }
  }): void {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: unknown) => {
        const isBackend = String(url).includes('featured-hero')
        const r = isBackend ? routes.backend : routes.file
        if (!r) return Promise.resolve({ ok: false, json: async () => ({}) })
        return Promise.resolve({ ok: r.ok ?? true, json: async () => r.body })
      }),
    )
  }

  it('backend override wins over the static file', async () => {
    stubRouted({
      backend: { body: { hero: { datasetId: 'feat', window: activeWindow, headline: 'Backend' } } },
      file: { body: { datasetId: 'other', window: activeWindow } },
    })
    const res = await getHeroCandidate([ds('feat'), ds('other'), realtime], { now: NOW })
    expect(res).toMatchObject({ source: 'override', headline: 'Backend' })
    expect(res?.dataset.id).toBe('feat')
  })

  it('falls back to the static file when the backend has no pin', async () => {
    stubRouted({
      backend: { body: { hero: null } },
      file: { body: { datasetId: 'feat', window: activeWindow } },
    })
    const res = await getHeroCandidate([ds('feat')], { now: NOW })
    expect(res?.dataset.id).toBe('feat')
    expect(res?.source).toBe('override')
  })

  it('falls back to the static file when the backend is unreachable (503)', async () => {
    stubRouted({
      backend: { ok: false },
      file: { body: { datasetId: 'feat', window: activeWindow } },
    })
    const res = await getHeroCandidate([ds('feat')], { now: NOW })
    expect(res?.dataset.id).toBe('feat')
  })

  it('an expired backend pin is authoritative — does not consult the file', async () => {
    // Backend has a pin (expired); file has an active pin. Because the
    // backend is authoritative when set, the expired pin falls through
    // to auto-derive rather than to the file.
    stubRouted({
      backend: { body: { hero: { datasetId: 'feat', window: expiredWindow } } },
      file: { body: { datasetId: 'feat', window: activeWindow } },
    })
    const res = await getHeroCandidate([ds('feat'), realtime], { now: NOW })
    expect(res?.source).toBe('auto')
    expect(res?.dataset.id).toBe('rt')
  })
})

describe('getHeroCandidate — approved event source', () => {
  const activeWindow = { start: '2026-05-01T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z' }
  const realtime = ds('rt', { tags: [REAL_TIME_TAG], endTime: '2026-06-01T00:00:00.000Z' })
  const eventBody = {
    event: {
      title: 'Hurricane Lena',
      datasetId: 'feat',
      source: { name: 'NOAA', url: 'https://example.gov/storm', publishedAt: '2026-05-30T00:00:00Z' },
    },
  }

  /** Route fetch across the three hero sources by URL. */
  function stubHero(routes: { hero?: unknown; file?: unknown; event?: unknown }): void {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: unknown) => {
        const u = String(url)
        const body = u.includes('featured-event')
          ? routes.event
          : u.includes('featured-hero')
            ? routes.hero
            : routes.file
        return Promise.resolve({ ok: body !== undefined, json: async () => body ?? {} })
      }),
    )
  }

  it('surfaces an approved event when there is no curator pin', async () => {
    stubHero({ hero: { hero: null }, file: {}, event: eventBody })
    const res = await getHeroCandidate([ds('feat'), realtime], { now: NOW })
    expect(res?.source).toBe('event')
    expect(res?.dataset.id).toBe('feat')
    expect(res?.headline).toBe('Hurricane Lena')
    expect(res?.event?.source).toEqual({ name: 'NOAA', url: 'https://example.gov/storm', publishedAt: '2026-05-30T00:00:00Z' })
  })

  it('a curator pin beats the event', async () => {
    stubHero({
      hero: { hero: { datasetId: 'feat', window: activeWindow, headline: 'Pinned' } },
      file: {},
      event: eventBody,
    })
    const res = await getHeroCandidate([ds('feat'), realtime], { now: NOW })
    expect(res?.source).toBe('override')
    expect(res?.headline).toBe('Pinned')
  })

  it('falls through to auto-derive when the event dataset is not in the catalog', async () => {
    stubHero({ hero: { hero: null }, file: {}, event: { event: { ...eventBody.event, datasetId: 'missing' } } })
    const res = await getHeroCandidate([ds('feat'), realtime], { now: NOW })
    expect(res?.source).toBe('auto')
    expect(res?.dataset.id).toBe('rt')
  })

  it('falls through to auto-derive when there is no approved event', async () => {
    stubHero({ hero: { hero: null }, file: {}, event: { event: null } })
    const res = await getHeroCandidate([ds('feat'), realtime], { now: NOW })
    expect(res?.source).toBe('auto')
  })

  it('rejects a non-http(s) source url (XSS defense) and falls through', async () => {
    stubHero({
      hero: { hero: null },
      file: {},
      event: { event: { ...eventBody.event, source: { name: 'NOAA', url: 'javascript:alert(1)' } } },
    })
    const res = await getHeroCandidate([ds('feat'), realtime], { now: NOW })
    expect(res?.source).toBe('auto') // not 'event' — the bad-url event was dropped
  })
})
