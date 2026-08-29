// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Unit tests for the pure shot sequencer (`tour-stop-order.ts`).
 *
 * Coverage: the opener is always the strongest match; a near-duplicate
 * of the previous stop loses to a weaker but distinct one; a clearly
 * better match still wins against a mild overlap; determinism and tie
 * behaviour; the degenerate inputs (empty pool, all-null scores,
 * limit larger than the pool); and the antimeridian bbox rule.
 */

import { describe, expect, it } from 'vitest'
import {
  bboxOverlap,
  DEFAULT_VARIETY_WEIGHT,
  orderTourStops,
  stopSimilarity,
  type StopCandidate,
} from './tour-stop-order'

function candidate(
  id: string,
  matchScore: number | null,
  categories: string[] = [],
  keywords: string[] = [],
  bbox: StopCandidate['bbox'] = null,
): StopCandidate {
  return { id, matchScore, categories, keywords, bbox }
}

describe('orderTourStops', () => {
  it('opens on the strongest match', () => {
    const pool = [
      candidate('b', 0.4, ['topic:fire']),
      candidate('a', 0.9, ['topic:fire']),
      candidate('c', 0.6, ['topic:ocean']),
    ]
    expect(orderTourStops(pool, { limit: 3 })[0]).toBe('a')
  })

  it('prefers a distinct stop over a near-duplicate of the previous one', () => {
    // `twin` matches better than `other` but is identical to the
    // opener on every facet; `other` shares nothing.
    const pool = [
      candidate('opener', 1, ['topic:fire', 'agency:noaa'], ['smoke', 'wildfire'], {
        n: 45, s: 35, w: -110, e: -100,
      }),
      candidate('twin', 0.8, ['topic:fire', 'agency:noaa'], ['smoke', 'wildfire'], {
        n: 45, s: 35, w: -110, e: -100,
      }),
      candidate('other', 0.55, ['topic:ocean'], ['sst'], { n: 10, s: -10, w: 100, e: 140 }),
    ]
    const order = orderTourStops(pool, { limit: 3 })
    expect(order[0]).toBe('opener')
    expect(order[1]).toBe('other')
    expect(order[2]).toBe('twin')
  })

  it('still lets a clearly better match win against a mild overlap', () => {
    // `strong` shares one of four keywords with the opener; `weak` is
    // unrelated but scores far lower. The blend should keep `strong`.
    const pool = [
      candidate('opener', 1, ['topic:fire'], ['smoke']),
      candidate('strong', 0.95, ['topic:air'], ['smoke', 'aerosol', 'pm25', 'aod']),
      candidate('weak', 0.05, ['topic:ocean'], ['sst']),
    ]
    expect(orderTourStops(pool, { limit: 2 })[1]).toBe('strong')
  })

  it('honours varietyWeight at both extremes', () => {
    const pool = [
      candidate('opener', 1, ['topic:fire'], ['smoke']),
      candidate('twin', 0.9, ['topic:fire'], ['smoke']),
      candidate('other', 0.5, ['topic:ocean'], ['sst']),
    ]
    // 0 → a plain score sort, duplicates and all.
    expect(orderTourStops(pool, { limit: 2, varietyWeight: 0 })[1]).toBe('twin')
    // 1 → score only picks the opener; everything after is variety.
    expect(orderTourStops(pool, { limit: 2, varietyWeight: 1 })[1]).toBe('other')
  })

  it('is deterministic and breaks ties on id, not input order', () => {
    const pool = [candidate('zebra', 0.5), candidate('alpha', 0.5), candidate('mango', 0.5)]
    const forward = orderTourStops(pool, { limit: 3 })
    const reversed = orderTourStops([...pool].reverse(), { limit: 3 })
    expect(forward).toEqual(reversed)
    expect(forward[0]).toBe('alpha')
  })

  it('treats an all-null-score pool as variety-only rather than erroring', () => {
    const pool = [
      candidate('a', null, ['topic:fire']),
      candidate('b', null, ['topic:fire']),
      candidate('c', null, ['topic:ocean']),
    ]
    const order = orderTourStops(pool, { limit: 3 })
    expect(order).toHaveLength(3)
    // With no score signal the second stop is the one that differs.
    expect(order[1]).toBe('c')
  })

  it('handles the degenerate inputs', () => {
    expect(orderTourStops([], { limit: 4 })).toEqual([])
    expect(orderTourStops([candidate('a', 1)], { limit: 0 })).toEqual([])
    expect(orderTourStops([candidate('a', 1)], { limit: -3 })).toEqual([])
    // Fewer candidates than the limit returns them all, no padding.
    expect(orderTourStops([candidate('a', 1), candidate('b', 0.5)], { limit: 9 })).toEqual([
      'a',
      'b',
    ])
  })

  it('never drops or duplicates a candidate', () => {
    const pool = Array.from({ length: 12 }, (_, i) =>
      candidate(`d${i}`, i / 12, [`topic:${i % 3}`], [`kw${i % 4}`]),
    )
    const order = orderTourStops(pool, { limit: 5 })
    expect(order).toHaveLength(5)
    expect(new Set(order).size).toBe(5)
    for (const id of order) expect(pool.some(c => c.id === id)).toBe(true)
  })

  it('exposes a variety weight inside the documented range', () => {
    expect(DEFAULT_VARIETY_WEIGHT).toBeGreaterThan(0)
    expect(DEFAULT_VARIETY_WEIGHT).toBeLessThan(1)
  })
})

describe('bboxOverlap', () => {
  const box = { n: 45, s: 35, w: -110, e: -100 }

  it('is 1 for an identical box and 0 for a disjoint one', () => {
    expect(bboxOverlap(box, box)).toBeCloseTo(1)
    expect(bboxOverlap(box, { n: 10, s: 0, w: 100, e: 120 })).toBe(0)
  })

  it('scores a partial overlap between 0 and 1', () => {
    const overlap = bboxOverlap(box, { n: 50, s: 40, w: -105, e: -95 })
    expect(overlap).toBeGreaterThan(0)
    expect(overlap).toBeLessThan(1)
  })

  it('returns 0 when either box is missing', () => {
    expect(bboxOverlap(null, box)).toBe(0)
    expect(bboxOverlap(box, null)).toBe(0)
  })

  it('declines to score an antimeridian-wrapping box rather than guess', () => {
    // w > e means the box wraps ±180°. Under-penalising is the safe
    // direction: a stop is never dropped for a miscomputed overlap.
    expect(bboxOverlap({ n: 10, s: -10, w: 170, e: -170 }, { n: 10, s: -10, w: 170, e: -170 })).toBe(0)
  })
})

describe('stopSimilarity', () => {
  it('is 1 for identical candidates and 0 for disjoint ones', () => {
    const a = candidate('a', 1, ['topic:fire'], ['smoke'], { n: 1, s: 0, w: 0, e: 1 })
    const b = candidate('b', 1, ['topic:fire'], ['smoke'], { n: 1, s: 0, w: 0, e: 1 })
    expect(stopSimilarity(a, b)).toBeCloseTo(1)
    const c = candidate('c', 1, ['topic:ocean'], ['sst'], { n: 40, s: 30, w: 100, e: 110 })
    expect(stopSimilarity(a, c)).toBe(0)
  })

  it('scores an empty facet list as no evidence, not as a match', () => {
    const bare = candidate('bare', 1)
    expect(stopSimilarity(bare, bare)).toBe(0)
  })
})
