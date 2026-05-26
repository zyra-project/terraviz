import { describe, it, expect } from 'vitest'
import {
  buildTimeline,
  isRealtimeRow,
  toFractionalYear,
} from './catalogTimeline'
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
    ...overrides,
  }
}

// Fixed clock for deterministic real-time detection.
// 2025-06-01 12:00 UTC.
const NOW_MS = Date.UTC(2025, 5, 1, 12)

describe('toFractionalYear', () => {
  it('returns the integer year for a bare four-digit prefix', () => {
    expect(toFractionalYear('2024')).toBe(2024)
  })

  it('returns 0-fraction for Jan 1 UTC', () => {
    expect(toFractionalYear('2020-01-01T00:00:00Z')).toBe(2020)
  })

  it('returns ~0.5 for July 1', () => {
    const v = toFractionalYear('2020-07-01T00:00:00Z')
    expect(v).toBeDefined()
    // 2020 is a leap year — Jan 1..Jul 1 spans 182 days of 366.
    expect(v! - 2020).toBeCloseTo(182 / 366, 2)
  })

  it('handles a non-leap year correctly', () => {
    const v = toFractionalYear('2021-07-01T00:00:00Z')
    expect(v).toBeDefined()
    // 2021 is not a leap year — Jan 1..Jul 1 spans 181 days of 365.
    expect(v! - 2021).toBeCloseTo(181 / 365, 2)
  })

  it('returns the integer year for historical dates < year 100', () => {
    // Year 0 / year 1 / year 50 — JS Date's UTC year encoding gets
    // squirrelly for low years; we fall through to the integer
    // extractor (and "year 0" stays year 0).
    expect(toFractionalYear('0000-01-01')).toBe(0)
    expect(toFractionalYear('0001-01-01')).toBe(1)
    expect(toFractionalYear('0050')).toBe(50)
  })

  it('returns undefined for missing or unparseable strings', () => {
    expect(toFractionalYear(undefined)).toBeUndefined()
    expect(toFractionalYear(null)).toBeUndefined()
    expect(toFractionalYear('')).toBeUndefined()
    expect(toFractionalYear('not-a-year')).toBeUndefined()
  })
})

describe('isRealtimeRow', () => {
  it('flags datasets tagged Real-Time', () => {
    const dataset = makeDataset({ tags: ['Water', 'Real-Time'] })
    expect(isRealtimeRow(dataset, NOW_MS)).toBe(true)
  })

  it('flags datasets whose endTime is within the last 24 h', () => {
    const dataset = makeDataset({
      tags: ['Water'],
      endTime: new Date(NOW_MS - 60 * 60 * 1000).toISOString(), // -1 h
    })
    expect(isRealtimeRow(dataset, NOW_MS)).toBe(true)
  })

  it('flags datasets whose endTime is within the next 24 h (clock skew)', () => {
    // A streaming dataset's endTime sometimes leads "now" by minutes;
    // we accept the ±24 h window symmetrically rather than only past.
    const dataset = makeDataset({
      tags: ['Water'],
      endTime: new Date(NOW_MS + 30 * 60 * 1000).toISOString(),
    })
    expect(isRealtimeRow(dataset, NOW_MS)).toBe(true)
  })

  it('does not flag datasets with stale endTime and no tag', () => {
    const dataset = makeDataset({
      tags: ['Water'],
      endTime: new Date(NOW_MS - 7 * 24 * 60 * 60 * 1000).toISOString(),
    })
    expect(isRealtimeRow(dataset, NOW_MS)).toBe(false)
  })

  it('does not flag undated rows', () => {
    const dataset = makeDataset({ tags: ['Water'], endTime: undefined })
    expect(isRealtimeRow(dataset, NOW_MS)).toBe(false)
  })

  it('handles malformed endTime by returning false', () => {
    const dataset = makeDataset({ endTime: 'not-a-date' })
    expect(isRealtimeRow(dataset, NOW_MS)).toBe(false)
  })
})

describe('buildTimeline — baseline shape', () => {
  it('emits one row per filtered dataset with a parseable startTime', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', startTime: '2020-01-01', endTime: '2024-01-01' }),
      makeDataset({ id: 'd2', startTime: '2010-01-01', endTime: '2015-01-01' }),
    ]
    const tl = buildTimeline(datasets, {}, '', { now: NOW_MS })
    expect(tl.rows).toHaveLength(2)
    expect(tl.filteredDatasetCount).toBe(2)
    expect(tl.undatedCount).toBe(0)
  })

  it('excludes rows without startTime and counts them in undatedCount', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', startTime: '2020-01-01' }),
      makeDataset({ id: 'd2', startTime: undefined, endTime: undefined }),
      makeDataset({ id: 'd3', startTime: undefined, endTime: undefined }),
    ]
    const tl = buildTimeline(datasets, {}, '', { now: NOW_MS })
    expect(tl.rows).toHaveLength(1)
    expect(tl.rows[0].datasetId).toBe('d1')
    expect(tl.undatedCount).toBe(2)
    expect(tl.filteredDatasetCount).toBe(3)
  })

  it('sorts rows by start year ascending (oldest at top)', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'recent', startTime: '2020-01-01' }),
      makeDataset({ id: 'ancient', startTime: '0001-01-01', tags: ['Water'] }),
      makeDataset({ id: 'mid', startTime: '1900-01-01' }),
    ]
    const tl = buildTimeline(datasets, {}, '', { now: NOW_MS })
    expect(tl.rows.map(r => r.datasetId)).toEqual(['ancient', 'mid', 'recent'])
  })

  it('breaks tied start years by title for stable ordering', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', title: 'Beta', startTime: '2020-01-01' }),
      makeDataset({ id: 'd2', title: 'Alpha', startTime: '2020-01-01' }),
    ]
    const tl = buildTimeline(datasets, {}, '', { now: NOW_MS })
    expect(tl.rows.map(r => r.title)).toEqual(['Alpha', 'Beta'])
  })

  it('emits domain spanning the visible rows', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', startTime: '2010-01-01', endTime: '2015-01-01' }),
      makeDataset({ id: 'd2', startTime: '2020-01-01', endTime: '2024-01-01' }),
    ]
    const tl = buildTimeline(datasets, {}, '', { now: NOW_MS })
    expect(tl.domain).toBeDefined()
    expect(tl.domain!.min).toBe(2010)
    expect(tl.domain!.max).toBe(2024)
  })

  it('returns an undefined domain when no rows are visible', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', startTime: undefined }),
    ]
    const tl = buildTimeline(datasets, {}, '', { now: NOW_MS })
    expect(tl.rows).toHaveLength(0)
    expect(tl.domain).toBeUndefined()
  })

  it('pads the domain when every row collapses to a single year', () => {
    // A degenerate case — every visible row is instantaneous at the
    // same date. A zero-width domain would crash d3's linear scale.
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', startTime: '2020', endTime: undefined }),
      makeDataset({ id: 'd2', startTime: '2020', endTime: undefined }),
    ]
    const tl = buildTimeline(datasets, {}, '', { now: NOW_MS })
    expect(tl.domain).toBeDefined()
    expect(tl.domain!.max).toBeGreaterThan(tl.domain!.min)
  })
})

describe('buildTimeline — row shape', () => {
  it('preserves start/end fractional years and original ISO strings', () => {
    const datasets: Dataset[] = [
      makeDataset({
        id: 'd1',
        startTime: '2020-01-01T00:00:00Z',
        endTime: '2024-07-01T00:00:00Z',
      }),
    ]
    const tl = buildTimeline(datasets, {}, '', { now: NOW_MS })
    const row = tl.rows[0]
    expect(row.start).toBe(2020)
    expect(row.end).toBeCloseTo(2024 + 182 / 366, 2)
    expect(row.startIso).toBe('2020-01-01T00:00:00Z')
    expect(row.endIso).toBe('2024-07-01T00:00:00Z')
    expect(row.isRealtime).toBe(false)
    expect(row.group).toBe('category-content')
  })

  it('flags real-time rows via the tag', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water', 'Real-Time'], startTime: '2020-01-01' }),
    ]
    const tl = buildTimeline(datasets, {}, '', { now: NOW_MS })
    expect(tl.rows[0].isRealtime).toBe(true)
  })

  it('flags real-time rows via the 24h-fresh endTime heuristic', () => {
    const datasets: Dataset[] = [
      makeDataset({
        id: 'd1',
        tags: ['Water'],
        startTime: '2020-01-01',
        endTime: new Date(NOW_MS - 60 * 60 * 1000).toISOString(),
      }),
    ]
    const tl = buildTimeline(datasets, {}, '', { now: NOW_MS })
    expect(tl.rows[0].isRealtime).toBe(true)
  })

  it('promotes the end of a tagged real-time row with no endTime to "now"', () => {
    // The plan: real-time datasets render as an open-ended bar
    // terminating at the right edge of the visible window. We
    // implement that as "end === now fractional year" so the bar
    // extends to the present.
    const datasets: Dataset[] = [
      makeDataset({
        id: 'd1',
        tags: ['Real-Time'],
        startTime: '2020-01-01',
        endTime: undefined,
      }),
    ]
    const tl = buildTimeline(datasets, {}, '', { now: NOW_MS })
    const row = tl.rows[0]
    expect(row.end).toBeGreaterThan(2024)
    expect(row.endIso).toBeUndefined()
  })

  it('treats a single-point (startTime only, not real-time) as instantaneous', () => {
    const datasets: Dataset[] = [
      makeDataset({
        id: 'd1',
        tags: ['Water'],
        startTime: '2020-06-01',
        endTime: undefined,
      }),
    ]
    const tl = buildTimeline(datasets, {}, '', { now: NOW_MS })
    const row = tl.rows[0]
    expect(row.start).toBe(row.end)
    expect(row.endIso).toBeUndefined()
  })

  it('extends the domain past "now" for future-dated forecast horizons', () => {
    const datasets: Dataset[] = [
      makeDataset({
        id: 'forecast',
        startTime: '2020-01-01',
        endTime: '2100-01-01',
      }),
    ]
    const tl = buildTimeline(datasets, {}, '', { now: NOW_MS })
    expect(tl.domain!.max).toBe(2100)
  })

  it('supports year-zero start dates', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', startTime: '0000-01-01', endTime: '2024-01-01' }),
    ]
    const tl = buildTimeline(datasets, {}, '', { now: NOW_MS })
    expect(tl.rows[0].start).toBe(0)
    expect(tl.domain!.min).toBe(0)
  })

  it('swaps a malformed end<start without throwing', () => {
    // A catalog typo where endTime parses to before startTime
    // shouldn't crash the build — we clamp end up to start so the
    // bar collapses to a point rather than drawing in reverse.
    const datasets: Dataset[] = [
      makeDataset({
        id: 'd1',
        startTime: '2020-01-01',
        endTime: '2010-01-01',
      }),
    ]
    const tl = buildTimeline(datasets, {}, '', { now: NOW_MS })
    const row = tl.rows[0]
    expect(row.end).toBeGreaterThanOrEqual(row.start)
  })
})

describe('buildTimeline — filter pass-through', () => {
  it('honours chip-rail multi-select category filter', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water'], startTime: '2020-01-01' }),
      makeDataset({ id: 'd2', tags: ['Land'], startTime: '2020-01-01' }),
    ]
    const tl = buildTimeline(
      datasets,
      { category: { kind: 'multi-select', values: ['Water'] } },
      '',
      { now: NOW_MS },
    )
    expect(tl.rows.map(r => r.datasetId)).toEqual(['d1'])
  })

  it('honours search-query prefix tokens via parseSearchQuery', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'd1', tags: ['Water'], startTime: '2020-01-01' }),
      makeDataset({ id: 'd2', tags: ['Land'], startTime: '2020-01-01' }),
    ]
    const tl = buildTimeline(datasets, {}, 'category:Water', { now: NOW_MS })
    expect(tl.rows.map(r => r.datasetId)).toEqual(['d1'])
  })

  it('honours the dataCoverageYear range predicate (brush-style filter)', () => {
    // Two coverage rows; brushing 2015..2018 picks the one that
    // overlaps the range.
    const datasets: Dataset[] = [
      makeDataset({ id: 'old', startTime: '2000-01-01', endTime: '2005-01-01' }),
      makeDataset({ id: 'mid', startTime: '2015-01-01', endTime: '2020-01-01' }),
    ]
    const tl = buildTimeline(
      datasets,
      { dataCoverageYear: { kind: 'range', min: 2015, max: 2018 } },
      '',
      { now: NOW_MS },
    )
    expect(tl.rows.map(r => r.datasetId)).toEqual(['mid'])
  })

  it('excludes hidden datasets via filterDatasets', () => {
    const datasets: Dataset[] = [
      makeDataset({ id: 'visible', startTime: '2020-01-01' }),
      makeDataset({ id: 'hidden', startTime: '2020-01-01', isHidden: true }),
    ]
    const tl = buildTimeline(datasets, {}, '', { now: NOW_MS })
    expect(tl.rows.map(r => r.datasetId)).toEqual(['visible'])
  })
})
