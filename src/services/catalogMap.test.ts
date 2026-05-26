import { describe, it, expect } from 'vitest'
import {
  buildMap,
  crossesAntimeridian,
  isGlobalBbox,
} from './catalogMap'
import type { Dataset } from '../types'

function makeDataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: 'd1',
    title: 'Sea Surface Temperature',
    format: 'video/mp4',
    dataLink: 'https://example.com/data.mp4',
    tags: ['Water'],
    startTime: '2020-01-01T00:00:00Z',
    endTime: '2024-01-01T00:00:00Z',
    boundingBox: { n: 45, s: -45, e: 90, w: -90 },
    ...overrides,
  }
}

// Fixed clock for deterministic real-time detection.
// 2025-06-01 12:00 UTC.
const NOW_MS = Date.UTC(2025, 5, 1, 12)

describe('isGlobalBbox', () => {
  it('flags the canonical worldwide bbox', () => {
    expect(isGlobalBbox({ n: 90, s: -90, e: 180, w: -180 })).toBe(true)
  })

  it('flags slightly-padded worldwide bboxes (89/-89 thresholds)', () => {
    // Enriched-metadata rounding occasionally produces 89.99 / -89.99
    // instead of exact 90 / -90; the threshold is permissive enough
    // to catch them.
    expect(isGlobalBbox({ n: 89, s: -89, e: 180, w: -180 })).toBe(true)
    expect(isGlobalBbox({ n: 89.5, s: -89.5, e: 179, w: -179 })).toBe(true)
  })

  it('rejects bboxes that miss either pole', () => {
    expect(isGlobalBbox({ n: 80, s: -90, e: 180, w: -180 })).toBe(false)
    expect(isGlobalBbox({ n: 90, s: -80, e: 180, w: -180 })).toBe(false)
  })

  it('rejects bboxes whose east-west span is < 358 degrees', () => {
    expect(isGlobalBbox({ n: 90, s: -90, e: 170, w: -170 })).toBe(false)
  })

  it('treats antimeridian-crossing bboxes by their wrapped span', () => {
    // {w: 170, e: -170} wraps east through 180° back to -170, a 20°
    // span — not global.
    expect(isGlobalBbox({ n: 90, s: -90, e: -170, w: 170 })).toBe(false)
  })
})

describe('crossesAntimeridian', () => {
  it('flags a Pacific-centred bbox with w > e', () => {
    expect(crossesAntimeridian({ e: -170, w: 170 })).toBe(true)
  })

  it('does not flag a normal bbox', () => {
    expect(crossesAntimeridian({ e: 90, w: -90 })).toBe(false)
  })

  it('treats w == e as non-crossing (degenerate single-meridian box)', () => {
    expect(crossesAntimeridian({ e: 0, w: 0 })).toBe(false)
  })
})

describe('buildMap — baseline shape', () => {
  it('emits one overlay per filtered dataset with a boundingBox', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1' }),
      makeDataset({ id: 'd2', boundingBox: { n: 30, s: 10, e: 50, w: 40 } }),
    ]
    const map = buildMap(datasets, {}, '', { now: NOW_MS })
    expect(map.bboxes).toHaveLength(2)
    expect(map.filteredDatasetCount).toBe(2)
    expect(map.undatedCount).toBe(0)
    expect(map.hiddenGlobalCount).toBe(0)
  })

  it('excludes datasets without boundingBox and counts them in undatedCount', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1' }),
      makeDataset({ id: 'd2', boundingBox: undefined }),
      makeDataset({ id: 'd3', boundingBox: undefined }),
    ]
    const map = buildMap(datasets, {}, '', { now: NOW_MS })
    expect(map.bboxes.map(b => b.datasetId)).toEqual(['d1'])
    expect(map.undatedCount).toBe(2)
    expect(map.filteredDatasetCount).toBe(3)
  })

  it('excludes datasets with malformed boundingBox (NaN corners)', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1' }),
      makeDataset({ id: 'd2', boundingBox: { n: NaN, s: 0, e: 10, w: 0 } }),
    ]
    const map = buildMap(datasets, {}, '', { now: NOW_MS })
    expect(map.bboxes.map(b => b.datasetId)).toEqual(['d1'])
    expect(map.undatedCount).toBe(1)
  })

  it('excludes datasets whose bbox is inverted (n < s)', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1' }),
      makeDataset({ id: 'd2', boundingBox: { n: -45, s: 45, e: 90, w: -90 } }),
    ]
    const map = buildMap(datasets, {}, '', { now: NOW_MS })
    expect(map.bboxes.map(b => b.datasetId)).toEqual(['d1'])
    expect(map.undatedCount).toBe(1)
  })

  it('hides pure-global bboxes by default and counts them', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'regional', boundingBox: { n: 30, s: -30, e: 60, w: -60 } }),
      makeDataset({ id: 'global', boundingBox: { n: 90, s: -90, e: 180, w: -180 } }),
      makeDataset({ id: 'global2', boundingBox: { n: 90, s: -90, e: 180, w: -180 } }),
    ]
    const map = buildMap(datasets, {}, '', { now: NOW_MS })
    expect(map.bboxes.map(b => b.datasetId)).toEqual(['regional'])
    expect(map.hiddenGlobalCount).toBe(2)
    expect(map.filteredDatasetCount).toBe(3)
  })

  it('surfaces global bboxes when includeGlobal is true', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'regional', boundingBox: { n: 30, s: -30, e: 60, w: -60 } }),
      makeDataset({ id: 'global', boundingBox: { n: 90, s: -90, e: 180, w: -180 } }),
    ]
    const map = buildMap(datasets, {}, '', { now: NOW_MS, includeGlobal: true })
    expect(map.bboxes.map(b => b.datasetId)).toEqual(['regional', 'global'])
    expect(map.hiddenGlobalCount).toBe(0)
    expect(map.bboxes[1].global).toBe(true)
  })
})

describe('buildMap — row shape', () => {
  it('preserves bounding-box corners verbatim', () => {
    const datasets: Dataset[] = [
      makeDataset({ boundingBox: { n: 12.5, s: -3.25, e: 45, w: 30 } }),
    ]
    const map = buildMap(datasets, {}, '', { now: NOW_MS })
    expect(map.bboxes[0].bounds).toEqual({ n: 12.5, s: -3.25, e: 45, w: 30 })
  })

  it('flags antimeridian-crossing bboxes without mutating their corners', () => {
    const datasets: Dataset[] = [
      makeDataset({ boundingBox: { n: 30, s: -30, e: -170, w: 170 } }),
    ]
    const map = buildMap(datasets, {}, '', { now: NOW_MS })
    expect(map.bboxes[0].crossesAntimeridian).toBe(true)
    // The bounds stay as-is; rendering wrap is the UI's job.
    expect(map.bboxes[0].bounds).toEqual({ n: 30, s: -30, e: -170, w: 170 })
  })

  it('flags real-time rows via the Real-Time tag', () => {
    const datasets: Dataset[] = [
      makeDataset({ tags: ['Water', 'Real-Time'] }),
    ]
    const map = buildMap(datasets, {}, '', { now: NOW_MS })
    expect(map.bboxes[0].isRealtime).toBe(true)
  })

  it('flags real-time rows via the 24h-fresh endTime heuristic', () => {
    const datasets: Dataset[] = [
      makeDataset({
        tags: ['Water'],
        endTime: new Date(NOW_MS - 60 * 60 * 1000).toISOString(),
      }),
    ]
    const map = buildMap(datasets, {}, '', { now: NOW_MS })
    expect(map.bboxes[0].isRealtime).toBe(true)
  })

  it('assigns the category-content group uniformly', () => {
    const datasets: Dataset[] = [
      makeDataset(),
    ]
    const map = buildMap(datasets, {}, '', { now: NOW_MS })
    expect(map.bboxes[0].group).toBe('category-content')
  })
})

describe('buildMap — filter pass-through', () => {
  it('honours chip-rail multi-select category filter', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water'] }),
      makeDataset({ id: 'd2', tags: ['Land'] }),
    ]
    const map = buildMap(
      datasets,
      { category: { kind: 'multi-select', values: ['Water'] } },
      '',
      { now: NOW_MS },
    )
    expect(map.bboxes.map(b => b.datasetId)).toEqual(['d1'])
  })

  it('honours search-query prefix tokens via parseSearchQuery', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water'] }),
      makeDataset({ id: 'd2', tags: ['Land'] }),
    ]
    const map = buildMap(datasets, {}, 'category:Water', { now: NOW_MS })
    expect(map.bboxes.map(b => b.datasetId)).toEqual(['d1'])
  })

  it('honours the geographicRegion bbox predicate (draw-style filter)', () => {
    // Two datasets — one whose bbox overlaps the predicate, one whose
    // bbox is fully outside it.
    const datasets: Dataset[] = [
      makeDataset({ id: 'inside', boundingBox: { n: 40, s: 20, e: 30, w: 10 } }),
      makeDataset({ id: 'outside', boundingBox: { n: -10, s: -30, e: -50, w: -70 } }),
    ]
    const map = buildMap(
      datasets,
      { geographicRegion: { kind: 'bbox', n: 50, s: 10, e: 50, w: 0 } },
      '',
      { now: NOW_MS },
    )
    expect(map.bboxes.map(b => b.datasetId)).toEqual(['inside'])
  })

  it('excludes hidden datasets via filterDatasets', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'visible' }),
      makeDataset({ id: 'hidden', isHidden: true }),
    ]
    const map = buildMap(datasets, {}, '', { now: NOW_MS })
    expect(map.bboxes.map(b => b.datasetId)).toEqual(['visible'])
  })
})
