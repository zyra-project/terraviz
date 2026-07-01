import { describe, it, expect } from 'vitest'
import {
  AUTO_PAIR_THRESHOLD,
  compositePercent,
  autoPairTargets,
  locatorPoint,
  primaryCategory,
  type ReviewLink,
} from './events-model'

function link(over: Partial<ReviewLink>): ReviewLink {
  return { datasetId: 'd', datasetTitle: 'D', score: 0.9, signals: null, status: 'proposed', ...over }
}

describe('compositePercent', () => {
  it('scales 0–1 score to a whole percent, null passes through', () => {
    expect(compositePercent(link({ score: 0.91 }))).toBe(91)
    expect(compositePercent(link({ score: null }))).toBeNull()
  })
})

describe('autoPairTargets', () => {
  it('selects only still-proposed links at or above the threshold', () => {
    const event = {
      links: [
        link({ datasetId: 'strong', score: 0.98, status: 'proposed' }), // ✓ 98
        link({ datasetId: 'exactly', score: AUTO_PAIR_THRESHOLD / 100, status: 'proposed' }), // ✓ 90
        link({ datasetId: 'mid', score: 0.68, status: 'proposed' }), // ✗ below
        link({ datasetId: 'already', score: 0.99, status: 'approved' }), // ✗ not proposed
        link({ datasetId: 'noscore', score: null, status: 'proposed' }), // ✗ null
      ],
    }
    expect(autoPairTargets(event)).toEqual(['strong', 'exactly'])
  })

  it('honours a custom threshold', () => {
    const event = { links: [link({ datasetId: 'a', score: 0.7 }), link({ datasetId: 'b', score: 0.5 })] }
    expect(autoPairTargets(event, 60)).toEqual(['a'])
  })

  it('compares the raw score, not the rounded display percent', () => {
    // 0.895 rounds to 90% for display but is below a 90% approval bar.
    const event = {
      links: [
        link({ datasetId: 'justUnder', score: 0.895, status: 'proposed' }),
        link({ datasetId: 'justOver', score: 0.905, status: 'proposed' }),
      ],
    }
    expect(autoPairTargets(event)).toEqual(['justOver'])
  })
})

describe('locatorPoint', () => {
  it('prefers an explicit point', () => {
    expect(locatorPoint({ point: { lat: 46.4, lon: -117.2 } })).toEqual({ lat: 46.4, lon: -117.2 })
  })
  it('falls back to the bbox centre', () => {
    expect(locatorPoint({ boundingBox: { n: 10, s: 0, w: -20, e: 0 } })).toEqual({ lat: 5, lon: -10 })
  })
  it('returns null for region-only or missing geometry', () => {
    expect(locatorPoint({ regionName: 'Arctic' })).toBeNull()
    expect(locatorPoint(undefined)).toBeNull()
  })
})

describe('primaryCategory', () => {
  it('returns the first value of the first facet group', () => {
    expect(primaryCategory({ categories: { Wildfires: ['Fire', 'Smoke'] } })).toBe('Fire')
  })
  it('returns null when uncategorised', () => {
    expect(primaryCategory({ categories: {} })).toBeNull()
    expect(primaryCategory({})).toBeNull()
  })
})
