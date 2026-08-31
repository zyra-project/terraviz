// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect } from 'vitest'
import {
  AUTO_PAIR_THRESHOLD,
  compositePercent,
  autoPairTargets,
  scenarioFamily,
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

describe('scenarioFamily', () => {
  it('groups scenario variants of one field', () => {
    expect(scenarioFamily('Climate Model - Sea Ice Concentration: SSP1 (Low)')).toBe(
      'Climate Model - Sea Ice Concentration',
    )
    expect(scenarioFamily('Climate Model - Sea Ice Concentration: SSP5 (Very High)')).toBe(
      'Climate Model - Sea Ice Concentration',
    )
    expect(scenarioFamily('Air Temperature RCP8.5')).toBe('Air Temperature')
  })

  it('leaves distinct members of a titled series alone', () => {
    // The reason this is scenario-specific rather than colon-based: these
    // are eight different tsunamis, not one field under three scenarios.
    expect(scenarioFamily('Tsunami Historical Series: Chile - 1960')).toBeNull()
    expect(scenarioFamily('Tsunami Historical Series: Japan - 2011')).toBeNull()
    expect(scenarioFamily('Solar Eclipse Paths and Cloud Fractions: April')).toBeNull()
    expect(scenarioFamily('Exoplanet: Kepler-10b')).toBeNull()
    expect(scenarioFamily('Sea Surface Temperature - Real-time')).toBeNull()
  })

  it('handles absent and degenerate titles', () => {
    expect(scenarioFamily(null)).toBeNull()
    expect(scenarioFamily(undefined)).toBeNull()
    expect(scenarioFamily('')).toBeNull()
    // A title that is *only* a scenario has no stem to group on.
    expect(scenarioFamily('SSP2 (Moderate)')).toBeNull()
  })
})

describe('autoPairTargets scenario dedupe', () => {
  const family = (suffix: string, score: number, datasetId: string) =>
    link({ datasetId, score, datasetTitle: `Climate Model - Sea Ice Concentration: ${suffix}` })

  it('pairs only the best-scoring variant of a family', () => {
    const event = {
      links: [
        family('SSP2 (Moderate)', 0.93, 'ssp2'),
        family('SSP5 (Very High)', 0.95, 'ssp5'),
        family('SSP1 (Low)', 0.91, 'ssp1'),
      ],
    }
    expect(autoPairTargets(event)).toEqual(['ssp5'])
  })

  it('keeps unrelated links and separate families intact', () => {
    const event = {
      links: [
        family('SSP2 (Moderate)', 0.93, 'ice2'),
        family('SSP5 (Very High)', 0.95, 'ice5'),
        link({ datasetId: 'smoke', score: 0.94, datasetTitle: 'Global Smoke Forecast' }),
        link({ datasetId: 'precip5', score: 0.92, datasetTitle: 'Climate Model - Precipitation Change: SSP5 (Very High)' }),
        link({ datasetId: 'precip1', score: 0.91, datasetTitle: 'Climate Model - Precipitation Change: SSP1 (Low)' }),
      ],
    }
    // One per family, plus the unrelated dataset, in input order.
    expect(autoPairTargets(event)).toEqual(['ice5', 'smoke', 'precip5'])
  })

  it('breaks a tie on dataset id so the pick is stable', () => {
    const event = {
      links: [family('SSP5 (Very High)', 0.93, 'zulu'), family('SSP1 (Low)', 0.93, 'alpha')],
    }
    expect(autoPairTargets(event)).toEqual(['alpha'])
  })

  it('does not dedupe variants that fall below the threshold', () => {
    // Below the bar nothing pairs, deduped or not.
    const event = { links: [family('SSP5 (Very High)', 0.5, 'a'), family('SSP1 (Low)', 0.4, 'b')] }
    expect(autoPairTargets(event)).toEqual([])
  })

  it('never groups distinct members of a titled series', () => {
    const event = {
      links: [
        link({ datasetId: 'chile', score: 0.95, datasetTitle: 'Tsunami Historical Series: Chile - 1960' }),
        link({ datasetId: 'japan', score: 0.94, datasetTitle: 'Tsunami Historical Series: Japan - 2011' }),
      ],
    }
    expect(autoPairTargets(event)).toEqual(['chile', 'japan'])
  })
})

describe('autoPairTargets', () => {
  it('selects only still-proposed links at or above the threshold', () => {
    const event = {
      links: [
        link({ datasetId: 'strong', score: 0.98, status: 'proposed' }), // ✓ 98
        link({ datasetId: 'exactly', score: AUTO_PAIR_THRESHOLD / 100, status: 'proposed' }), // ✓ exactly at the bar
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
    // Half a display-point under the bar rounds *to* the bar but must
    // not clear it. Derived from the constant rather than written out:
    // the property holds at any threshold, and hardcoding the numbers
    // is what coupled this test to 90 and broke it when the bar moved.
    const bar = AUTO_PAIR_THRESHOLD / 100
    const event = {
      links: [
        link({ datasetId: 'justUnder', score: bar - 0.005, status: 'proposed' }),
        link({ datasetId: 'justOver', score: bar + 0.005, status: 'proposed' }),
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
