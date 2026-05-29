import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  addViewSeconds,
  countNewSince,
  getLastSession,
  getRecent,
  getVisitedIds,
  loadVisits,
  LAST_SESSION_STORAGE_KEY,
  onVisitsChange,
  recordVisit,
  resetVisitsForTests,
  VISITS_LRU_CAP,
  VISITS_STORAGE_KEY,
} from './visitMemory'
import type { Dataset } from '../types'

beforeEach(() => {
  localStorage.clear()
  resetVisitsForTests()
})

afterEach(() => {
  localStorage.clear()
  resetVisitsForTests()
  vi.useRealTimers()
})

/** Minimal Dataset stub — only the fields the queries read. */
function ds(id: string, opts: { dateAdded?: string; isHidden?: boolean } = {}): Dataset {
  return {
    id,
    title: id,
    dataLink: '',
    isHidden: opts.isHidden,
    enriched: opts.dateAdded ? { dateAdded: opts.dateAdded } : undefined,
  } as unknown as Dataset
}

describe('recordVisit', () => {
  it('creates an entry with firstVisit, lastVisit, and zero viewSeconds', () => {
    recordVisit('A')
    const visits = loadVisits()
    expect(visits.A).toBeDefined()
    expect(visits.A.firstVisit).toBe(visits.A.lastVisit)
    expect(visits.A.viewSeconds).toBe(0)
  })

  it('keeps firstVisit but bumps lastVisit on a repeat visit', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    recordVisit('A')
    const first = loadVisits().A.firstVisit
    vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'))
    recordVisit('A')
    const after = loadVisits().A
    expect(after.firstVisit).toBe(first)
    expect(after.lastVisit).toBe('2026-01-02T00:00:00.000Z')
  })

  it('ignores an empty id', () => {
    recordVisit('')
    expect(Object.keys(loadVisits())).toHaveLength(0)
  })

  it('persists to the versioned localStorage key', () => {
    recordVisit('A')
    expect(localStorage.getItem(VISITS_STORAGE_KEY)).toContain('"A"')
  })
})

describe('addViewSeconds', () => {
  it('accumulates across calls (across sessions)', () => {
    recordVisit('A')
    addViewSeconds('A', 10)
    addViewSeconds('A', 5.5)
    expect(loadVisits().A.viewSeconds).toBeCloseTo(15.5)
  })

  it('creates an entry when the dataset was never recorded', () => {
    addViewSeconds('Z', 4)
    expect(loadVisits().Z.viewSeconds).toBe(4)
  })

  it('ignores non-positive and non-finite durations', () => {
    recordVisit('A')
    addViewSeconds('A', 0)
    addViewSeconds('A', -3)
    addViewSeconds('A', Number.NaN)
    expect(loadVisits().A.viewSeconds).toBe(0)
  })
})

describe('getRecent', () => {
  it('returns ids newest-first', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    recordVisit('A')
    vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'))
    recordVisit('B')
    vi.setSystemTime(new Date('2026-01-03T00:00:00.000Z'))
    recordVisit('C')
    expect(getRecent(3)).toEqual(['C', 'B', 'A'])
  })

  it('caps at n', () => {
    for (const id of ['A', 'B', 'C', 'D']) recordVisit(id)
    expect(getRecent(2)).toHaveLength(2)
  })
})

describe('LRU cap', () => {
  it('evicts the least-recently-touched entry past the cap', () => {
    vi.useFakeTimers()
    // Fill to the cap, each with a distinct (increasing) timestamp.
    for (let i = 0; i < VISITS_LRU_CAP; i++) {
      vi.setSystemTime(new Date(2026, 0, 1, 0, 0, i))
      recordVisit(`d${i}`)
    }
    expect(Object.keys(loadVisits())).toHaveLength(VISITS_LRU_CAP)
    // One more — the oldest (d0) should be evicted.
    vi.setSystemTime(new Date(2026, 0, 2))
    recordVisit('overflow')
    const visits = loadVisits()
    expect(Object.keys(visits)).toHaveLength(VISITS_LRU_CAP)
    expect(visits.d0).toBeUndefined()
    expect(visits.overflow).toBeDefined()
  })
})

describe('getVisitedIds', () => {
  it('returns the set of visited ids', () => {
    recordVisit('A')
    recordVisit('B')
    expect(getVisitedIds()).toEqual(new Set(['A', 'B']))
  })
})

describe('countNewSince', () => {
  const catalog = [
    ds('old', { dateAdded: '2026-01-01' }),
    ds('new1', { dateAdded: '2026-03-01' }),
    ds('new2', { dateAdded: '2026-04-01' }),
    ds('hidden', { dateAdded: '2026-04-01', isHidden: true }),
    ds('undated'),
  ]

  it('counts catalog rows added after the given timestamp', () => {
    expect(countNewSince(catalog, '2026-02-01T00:00:00.000Z')).toBe(2)
  })

  it('fails closed for a null/unparseable since', () => {
    expect(countNewSince(catalog, null)).toBe(0)
    expect(countNewSince(catalog, 'not-a-date')).toBe(0)
  })

  it('excludes hidden rows and rows without a parseable dateAdded', () => {
    // Everything after 2025 — hidden + undated still excluded.
    expect(countNewSince(catalog, '2025-01-01T00:00:00.000Z')).toBe(3)
  })
})

describe('lastSession accessors', () => {
  it('round-trips a written timestamp', () => {
    // writeLastSession is imported lazily to keep the import list tidy.
    const iso = '2026-05-01T00:00:00.000Z'
    localStorage.setItem(LAST_SESSION_STORAGE_KEY, iso)
    expect(getLastSession()).toBe(iso)
  })

  it('returns null for a missing or unparseable value', () => {
    expect(getLastSession()).toBeNull()
    localStorage.setItem(LAST_SESSION_STORAGE_KEY, 'garbage')
    expect(getLastSession()).toBeNull()
  })
})

describe('onVisitsChange', () => {
  it('fires synchronously on mutation and unsubscribes cleanly', () => {
    const cb = vi.fn()
    const unsub = onVisitsChange(cb)
    recordVisit('A')
    expect(cb).toHaveBeenCalledTimes(1)
    unsub()
    recordVisit('B')
    expect(cb).toHaveBeenCalledTimes(1)
  })
})

describe('corrupt storage', () => {
  it('drops malformed entries on load rather than throwing', () => {
    localStorage.setItem(
      VISITS_STORAGE_KEY,
      JSON.stringify({
        good: { firstVisit: '2026-01-01', lastVisit: '2026-01-02', viewSeconds: 3 },
        bad1: { firstVisit: 123 },
        bad2: 'nope',
      }),
    )
    resetVisitsForTests()
    const visits = loadVisits()
    expect(visits.good).toBeDefined()
    expect(visits.bad1).toBeUndefined()
    expect(visits.bad2).toBeUndefined()
  })
})
