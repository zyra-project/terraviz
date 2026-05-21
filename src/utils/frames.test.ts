import { describe, expect, it } from 'vitest'
import { parseIsoDurationMs, resolveFrameQuery } from './frames'
import type { Dataset } from '../types'

const BASE_DATASET: Dataset = {
  id: 'DS_TEST',
  slug: 'ssta',
  title: 'Sea Surface Temperature Anomaly',
  format: 'video/mp4',
  dataLink: '/api/v1/datasets/DS_TEST/manifest',
  startTime: '2026-05-16T00:00:00.000Z',
  period: 'PT1H',
  frames: {
    count: 24,
    urlTemplate: 'https://assets.test/uploads/DS_TEST/01HYUP/frames/{index}.png',
  },
}

const PURE_SEQUENCE: Dataset = {
  ...BASE_DATASET,
  id: 'DS_SEQ',
  slug: 'seq',
  startTime: undefined,
  period: undefined,
}

describe('resolveFrameQuery (3pg/C)', () => {
  it('resolves `latest` to the final frame', () => {
    const r = resolveFrameQuery(BASE_DATASET, 'latest')!
    expect(r.index).toBe(23)
    expect(r.url).toContain('frames/00023.png')
    expect(r.displayName).toBe('ssta_20260516T230000Z.png')
  })

  it('resolves `first` to index 0', () => {
    const r = resolveFrameQuery(BASE_DATASET, 'first')!
    expect(r.index).toBe(0)
    expect(r.url).toContain('frames/00000.png')
  })

  it('resolves `index=N`', () => {
    const r = resolveFrameQuery(BASE_DATASET, 'index=5')!
    expect(r.index).toBe(5)
    expect(r.url).toContain('frames/00005.png')
  })

  it('resolves a bare integer', () => {
    const r = resolveFrameQuery(BASE_DATASET, '7')!
    expect(r.index).toBe(7)
  })

  it('resolves an ISO 8601 timestamp to the closest frame', () => {
    const r = resolveFrameQuery(BASE_DATASET, '2026-05-16T03:30:00Z')!
    // 3.5 hours past start — `Math.round(3.5)` is 4 in JavaScript
    // (rounds half toward positive infinity, not "ties to even").
    expect(r.index).toBe(4)
    expect(r.timestamp).toBe('2026-05-16T04:00:00.000Z')
  })

  it('clamps out-of-range indexes', () => {
    expect(resolveFrameQuery(BASE_DATASET, 'index=999')!.index).toBe(23)
    // The bare-integer regex requires non-negative digits; negative
    // forms fall through to ISO parsing and either resolve to a
    // timestamp or return null. Either is fine — we don't promise
    // a particular shape for `-1`.
  })

  it('returns null when the dataset has no frames envelope', () => {
    const noFrames: Dataset = { ...BASE_DATASET, frames: undefined }
    expect(resolveFrameQuery(noFrames, 'latest')).toBeNull()
  })

  it('returns null when an ISO timestamp is supplied on a pure-sequence row', () => {
    expect(resolveFrameQuery(PURE_SEQUENCE, '2026-05-16T03:00:00Z')).toBeNull()
  })

  it('renders pure-sequence display names for rows without period', () => {
    const r = resolveFrameQuery(PURE_SEQUENCE, 'index=3')!
    expect(r.displayName).toBe('seq_frame_00003.png')
    expect(r.timestamp).toBeNull()
  })

  it('returns null when the URL template lacks the {index} token', () => {
    const broken: Dataset = {
      ...BASE_DATASET,
      frames: { ...BASE_DATASET.frames!, urlTemplate: 'https://assets.test/no-token.png' },
    }
    expect(resolveFrameQuery(broken, 'latest')).toBeNull()
  })

  it('rejects unparseable queries', () => {
    expect(resolveFrameQuery(BASE_DATASET, 'next thursday')).toBeNull()
    expect(resolveFrameQuery(BASE_DATASET, 'index=banana')).toBeNull()
  })

  it('fails closed when frames.count is 0 (corrupt or mid-ingest row)', () => {
    // Phase 3pg-review/C — Copilot discussion_r3277396427. The
    // pre-fix path would resolve `latest` to `-1` and emit a
    // padded `-0001.png` key that R2 404s.
    const corrupt: Dataset = {
      ...BASE_DATASET,
      frames: { ...BASE_DATASET.frames!, count: 0 },
    }
    expect(resolveFrameQuery(corrupt, 'latest')).toBeNull()
    expect(resolveFrameQuery(corrupt, 'first')).toBeNull()
    expect(resolveFrameQuery(corrupt, 'index=0')).toBeNull()
    expect(resolveFrameQuery(corrupt, '0')).toBeNull()
  })

  it('fails closed for negative count', () => {
    const negative: Dataset = {
      ...BASE_DATASET,
      frames: { ...BASE_DATASET.frames!, count: -5 },
    }
    expect(resolveFrameQuery(negative, 'latest')).toBeNull()
  })
})

describe('parseIsoDurationMs (3pg/C)', () => {
  it('parses common shapes', () => {
    expect(parseIsoDurationMs('PT1H')).toBe(3_600_000)
    expect(parseIsoDurationMs('P1D')).toBe(86_400_000)
    expect(parseIsoDurationMs('PT30M')).toBe(1_800_000)
  })

  it('returns null on empty / garbage / undefined', () => {
    expect(parseIsoDurationMs(undefined)).toBeNull()
    expect(parseIsoDurationMs('')).toBeNull()
    expect(parseIsoDurationMs('P')).toBeNull()
    expect(parseIsoDurationMs('not-a-duration')).toBeNull()
  })
})
