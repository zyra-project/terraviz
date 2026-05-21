import { describe, expect, it } from 'vitest'
import {
  findClosestFrameIndex,
  findFrameWindow,
  frameTimestamp,
  parseFrameManifest,
  renderFrameDisplayName,
} from './frames-manifest'

const VALID_DIGEST = 'sha256:' + 'a'.repeat(64)

describe('parseFrameManifest (3pg/B)', () => {
  it('parses the canonical { index, filename, digest } shape', () => {
    const blob = JSON.stringify([
      { index: 0, filename: 'first.png', digest: VALID_DIGEST },
      { index: 1, filename: 'second.png', digest: VALID_DIGEST },
    ])
    const result = parseFrameManifest(blob)
    expect(result).not.toBeNull()
    expect(result!).toHaveLength(2)
    expect(result![0]).toEqual({ index: 0, filename: 'first.png', digest: VALID_DIGEST })
  })

  it('rejects an entry whose index does not match its array position', () => {
    // Phase 3pf-review/H invariant — a shuffled manifest would
    // cause downstream consumers to map indexes to the wrong
    // filenames / digests.
    const blob = JSON.stringify([
      { index: 1, filename: 'first.png', digest: VALID_DIGEST },
      { index: 0, filename: 'second.png', digest: VALID_DIGEST },
    ])
    expect(parseFrameManifest(blob)).toBeNull()
  })

  it('rejects a malformed digest', () => {
    const blob = JSON.stringify([{ index: 0, filename: 'first.png', digest: 'not-a-digest' }])
    expect(parseFrameManifest(blob)).toBeNull()
  })

  it('rejects non-JSON / non-array / missing-field shapes', () => {
    expect(parseFrameManifest('not-json')).toBeNull()
    expect(parseFrameManifest('{}')).toBeNull()
    expect(parseFrameManifest('[1, 2, 3]')).toBeNull()
    expect(
      parseFrameManifest(JSON.stringify([{ index: 0, filename: 'f.png' /* no digest */ }])),
    ).toBeNull()
  })
})

describe('renderFrameDisplayName (3pg/B)', () => {
  it('formats time-series rows as {slug}_{YYYYMMDDTHHMMSSZ}.{ext}', () => {
    expect(
      renderFrameDisplayName(
        { slug: 'ssta', start_time: '2026-05-16T12:00:00.000Z', period: 'PT1H' },
        'png',
        0,
      ),
    ).toBe('ssta_20260516T120000Z.png')
    expect(
      renderFrameDisplayName(
        { slug: 'ssta', start_time: '2026-05-16T12:00:00.000Z', period: 'PT1H' },
        'png',
        3,
      ),
    ).toBe('ssta_20260516T150000Z.png')
  })

  it('falls back to {slug}_frame_{NNNNN}.{ext} for pure-sequence rows', () => {
    expect(
      renderFrameDisplayName({ slug: 'seq', start_time: null, period: null }, 'jpg', 47),
    ).toBe('seq_frame_00047.jpg')
  })

  it('falls back to pure-sequence shape when period is unparseable', () => {
    expect(
      renderFrameDisplayName(
        { slug: 'broken', start_time: '2026-05-16T12:00:00.000Z', period: 'every-hour' },
        'png',
        2,
      ),
    ).toBe('broken_frame_00002.png')
  })
})

describe('findClosestFrameIndex (3pg/B)', () => {
  const row = {
    start_time: '2026-05-16T00:00:00.000Z',
    period: 'PT1H',
    frame_count: 24,
  }

  it('rounds to the nearest frame', () => {
    expect(findClosestFrameIndex(row, Date.parse('2026-05-16T01:14:00Z'))).toBe(1)
    expect(findClosestFrameIndex(row, Date.parse('2026-05-16T01:46:00Z'))).toBe(2)
  })

  it('clamps to [0, frame_count - 1]', () => {
    expect(findClosestFrameIndex(row, Date.parse('2026-05-01T00:00:00Z'))).toBe(0)
    expect(findClosestFrameIndex(row, Date.parse('2026-06-01T00:00:00Z'))).toBe(23)
  })

  it('returns null on non-time-series rows', () => {
    expect(
      findClosestFrameIndex({ start_time: null, period: null, frame_count: 5 }, 0),
    ).toBeNull()
  })
})

describe('findFrameWindow (3pg/B)', () => {
  const row = {
    start_time: '2026-05-16T00:00:00.000Z',
    period: 'PT1H',
    frame_count: 24,
  }

  it('returns the inclusive [from, to] index pair for an in-range window', () => {
    expect(
      findFrameWindow(
        row,
        Date.parse('2026-05-16T03:00:00Z'),
        Date.parse('2026-05-16T08:00:00Z'),
      ),
    ).toEqual({ fromIndex: 3, toIndex: 8 })
  })

  it('clamps to the series bounds when the window extends past either edge', () => {
    expect(
      findFrameWindow(
        row,
        Date.parse('2026-05-15T00:00:00Z'),
        Date.parse('2026-05-17T00:00:00Z'),
      ),
    ).toEqual({ fromIndex: 0, toIndex: 23 })
  })

  it('returns null when the window falls entirely outside the series', () => {
    expect(
      findFrameWindow(
        row,
        Date.parse('2026-05-01T00:00:00Z'),
        Date.parse('2026-05-15T00:00:00Z'),
      ),
    ).toBeNull()
  })
})

describe('frameTimestamp (3pg/B)', () => {
  it('returns startTime + period × index in ISO 8601', () => {
    expect(
      frameTimestamp({ start_time: '2026-05-16T00:00:00.000Z', period: 'PT1H' }, 5),
    ).toBe('2026-05-16T05:00:00.000Z')
  })

  it('returns null for non-time-series rows', () => {
    expect(frameTimestamp({ start_time: null, period: null }, 0)).toBeNull()
  })
})
