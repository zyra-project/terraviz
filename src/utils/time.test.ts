import { describe, it, expect } from 'vitest'
import {
  parseISO8601Duration,
  formatDuration,
  isSubDailyPeriod,
  calculateFrameDatetime,
  calculateFrameIndex,
  videoTimeToDate,
  dateToVideoTime,
  computeSiblingSyncCorrection,
  verifySiblingTime,
  shownFrameTime,
  MIN_PLAYBACK_RATE,
  MAX_PLAYBACK_RATE,
  SIBLING_MIN_READY_STATE,
  SIBLING_HARD_SEEK_THRESHOLD_S,
  SIBLING_SEEK_EPS_S,
  inferDisplayInterval,
  getSunPosition,
} from './time'

// ---------------------------------------------------------------------------
// parseISO8601Duration
// ---------------------------------------------------------------------------
describe('parseISO8601Duration', () => {
  it('parses a datetime string to a Date', () => {
    const result = parseISO8601Duration('2015-01-08T12:00:00')
    expect(result).toBeInstanceOf(Date)
    expect((result as Date).getFullYear()).toBe(2015)
  })

  it('parses P1D as 1 day', () => {
    const result = parseISO8601Duration('P1D') as { type: string; days: number }
    expect(result.type).toBe('day')
    expect(result.days).toBe(1)
  })

  it('parses P1W as 7 days', () => {
    const result = parseISO8601Duration('P1W') as { type: string; days: number }
    expect(result.type).toBe('week')
    expect(result.days).toBe(7)
  })

  it('parses P1M as ~30.44 days', () => {
    const result = parseISO8601Duration('P1M') as { type: string; days: number }
    expect(result.type).toBe('month')
    expect(result.days).toBeCloseTo(30.44)
  })

  it('parses P1Y as ~365.25 days', () => {
    const result = parseISO8601Duration('P1Y') as { type: string; days: number }
    expect(result.type).toBe('year')
    expect(result.days).toBeCloseTo(365.25)
  })

  it('parses PT1H as 1/24 days', () => {
    const result = parseISO8601Duration('PT1H') as { type: string; days: number }
    expect(result.type).toBe('hour')
    expect(result.days).toBeCloseTo(1 / 24)
  })

  it('parses PT15M as 15/(24*60) days', () => {
    const result = parseISO8601Duration('PT15M') as { type: string; days: number }
    expect(result.type).toBe('minute')
    expect(result.days).toBeCloseTo(15 / (24 * 60))
  })

  it('parses PT6H as custom type', () => {
    const result = parseISO8601Duration('PT6H') as { type: string; days: number }
    expect(result.type).toBe('custom')
    expect(result.days).toBeCloseTo(6 / 24)
  })

  it('parses combined P1Y2M3DT4H5M6S', () => {
    const result = parseISO8601Duration('P1Y2M3DT4H5M6S') as { type: string; days: number }
    expect(result.type).toBe('custom')
    // 365.25 + 2*30.44 + 3 + 4/24 + 5/(24*60) + 6/(24*60*60)
    const expected = 365.25 + 2 * 30.44 + 3 + 4 / 24 + 5 / 1440 + 6 / 86400
    expect(result.days).toBeCloseTo(expected, 3)
  })

  it('throws on invalid input', () => {
    // 'GARBAGE' has no 'T' so it won't be tried as a datetime, and it
    // doesn't match the duration regex, so the function must throw.
    expect(() => parseISO8601Duration('GARBAGE')).toThrow('Invalid ISO 8601 value')
  })
})

// ---------------------------------------------------------------------------
// isSubDailyPeriod
// ---------------------------------------------------------------------------
describe('isSubDailyPeriod', () => {
  it('returns true for PT6H', () => expect(isSubDailyPeriod('PT6H')).toBe(true))
  it('returns true for PT15M', () => expect(isSubDailyPeriod('PT15M')).toBe(true))
  it('returns false for P1D', () => expect(isSubDailyPeriod('P1D')).toBe(false))
  it('returns false for P1W', () => expect(isSubDailyPeriod('P1W')).toBe(false))
  it('returns false for undefined', () => expect(isSubDailyPeriod(undefined)).toBe(false))
  it('returns false for null', () => expect(isSubDailyPeriod(null)).toBe(false))
})

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------
describe('formatDuration', () => {
  it('formats < 1 hour as m:ss', () => {
    expect(formatDuration(90)).toBe('1:30')
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(59)).toBe('0:59')
  })

  it('formats >= 1 hour as h:mm:ss', () => {
    expect(formatDuration(3600)).toBe('1:00:00')
    expect(formatDuration(3661)).toBe('1:01:01')
    expect(formatDuration(7384)).toBe('2:03:04')
  })

  it('truncates fractional seconds', () => {
    expect(formatDuration(90.9)).toBe('1:30')
  })
})

// ---------------------------------------------------------------------------
// calculateFrameDatetime
// ---------------------------------------------------------------------------
describe('calculateFrameDatetime', () => {
  const start = new Date('2020-01-01T00:00:00Z')
  const end = new Date('2020-01-11T00:00:00Z') // 10 days later

  it('returns start for frame 0', () => {
    const result = calculateFrameDatetime(0, 11, start, end)
    expect(result.getTime()).toBe(start.getTime())
  })

  it('returns end for last frame', () => {
    const result = calculateFrameDatetime(10, 11, start, end)
    expect(result.getTime()).toBe(end.getTime())
  })

  it('returns midpoint for middle frame', () => {
    const result = calculateFrameDatetime(5, 11, start, end)
    const mid = new Date('2020-01-06T00:00:00Z')
    expect(result.getTime()).toBe(mid.getTime())
  })
})

// ---------------------------------------------------------------------------
// calculateFrameIndex
// ---------------------------------------------------------------------------
describe('calculateFrameIndex', () => {
  const start = new Date('2020-01-01T00:00:00Z')
  const end = new Date('2020-01-11T00:00:00Z')

  it('returns 0 for start date', () => {
    expect(calculateFrameIndex(start, start, end, 11)).toBe(0)
  })

  it('returns last index for end date', () => {
    expect(calculateFrameIndex(end, start, end, 11)).toBe(10)
  })

  it('returns mid index for mid date', () => {
    const mid = new Date('2020-01-06T00:00:00Z')
    expect(calculateFrameIndex(mid, start, end, 11)).toBe(5)
  })

  it('clamps below 0', () => {
    const before = new Date('2019-12-01T00:00:00Z')
    expect(calculateFrameIndex(before, start, end, 11)).toBe(0)
  })

  it('clamps above totalFrames - 1', () => {
    const after = new Date('2021-01-01T00:00:00Z')
    expect(calculateFrameIndex(after, start, end, 11)).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// videoTimeToDate
// ---------------------------------------------------------------------------
describe('videoTimeToDate', () => {
  const start = new Date('2020-01-01T00:00:00Z')
  const end = new Date('2020-01-02T00:00:00Z') // 1 day

  it('returns start for time 0', () => {
    expect(videoTimeToDate(0, 100, start, end).getTime()).toBe(start.getTime())
  })

  it('returns end for time = duration', () => {
    expect(videoTimeToDate(100, 100, start, end).getTime()).toBe(end.getTime())
  })

  it('returns midpoint for half duration', () => {
    const result = videoTimeToDate(50, 100, start, end)
    const mid = new Date('2020-01-01T12:00:00Z')
    expect(result.getTime()).toBe(mid.getTime())
  })

  it('returns start when videoDuration is 0', () => {
    expect(videoTimeToDate(10, 0, start, end).getTime()).toBe(start.getTime())
  })

  it('clamps to end when video time > duration', () => {
    const result = videoTimeToDate(200, 100, start, end)
    expect(result.getTime()).toBe(end.getTime())
  })

  it('snaps to interval when snapIntervalMs provided', () => {
    const snapMs = 6 * 60 * 60 * 1000 // 6 hours
    // Half-way through a 1-day range = 12 hours → already on a 6h boundary
    const result = videoTimeToDate(50, 100, start, end, snapMs)
    expect(result.getTime() % snapMs).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// dateToVideoTime — the inverse of videoTimeToDate, used by multi-panel
// playback sync to seek sibling videos to the primary's real-world date.
// ---------------------------------------------------------------------------
describe('dateToVideoTime', () => {
  const start = new Date('2020-01-01T00:00:00Z')
  const end = new Date('2020-01-02T00:00:00Z') // 1 day

  it('returns videoTime=0 position=inside for the start date', () => {
    const { videoTime, position } = dateToVideoTime(start, 100, start, end)
    expect(videoTime).toBe(0)
    expect(position).toBe('inside')
  })

  it('returns videoTime=duration position=inside for the end date', () => {
    const { videoTime, position } = dateToVideoTime(end, 100, start, end)
    expect(videoTime).toBe(100)
    expect(position).toBe('inside')
  })

  it('returns videoTime at half duration for the midpoint date', () => {
    const mid = new Date('2020-01-01T12:00:00Z')
    const { videoTime, position } = dateToVideoTime(mid, 100, start, end)
    expect(videoTime).toBeCloseTo(50)
    expect(position).toBe('inside')
  })

  it('round-trips with videoTimeToDate', () => {
    // Any videoTime in [0, duration] → date → videoTime should be unchanged
    for (const t of [0, 13.7, 50, 87.3, 100]) {
      const date = videoTimeToDate(t, 100, start, end)
      const { videoTime, position } = dateToVideoTime(date, 100, start, end)
      expect(videoTime).toBeCloseTo(t, 5)
      expect(position).toBe('inside')
    }
  })

  it('returns position=before and videoTime=0 for dates before the range', () => {
    const before = new Date('2019-12-31T12:00:00Z')
    const { videoTime, position } = dateToVideoTime(before, 100, start, end)
    expect(videoTime).toBe(0)
    expect(position).toBe('before')
  })

  it('returns position=after and videoTime=duration for dates after the range', () => {
    const after = new Date('2020-01-03T00:00:00Z')
    const { videoTime, position } = dateToVideoTime(after, 100, start, end)
    expect(videoTime).toBe(100)
    expect(position).toBe('after')
  })

  it('handles zero-duration video gracefully', () => {
    const { videoTime, position } = dateToVideoTime(start, 0, start, end)
    expect(videoTime).toBe(0)
    expect(position).toBe('inside')
  })

  it('handles zero-range dataset (start == end) gracefully', () => {
    const point = new Date('2020-01-01T00:00:00Z')
    const { videoTime, position } = dateToVideoTime(point, 100, point, point)
    expect(videoTime).toBe(0)
    // Date is both the start and the end, not outside, so 'inside'
    expect(position).toBe('inside')
  })

  it('handles two datasets with no temporal overlap', () => {
    // Primary covers 2020, sibling covers 2023. A midpoint date in 2020
    // (from the primary) should land BEFORE the sibling's range.
    const sibStart = new Date('2023-01-01T00:00:00Z')
    const sibEnd = new Date('2023-12-31T00:00:00Z')
    const primaryMidpoint = new Date('2020-07-01T00:00:00Z')
    const { videoTime, position } = dateToVideoTime(primaryMidpoint, 100, sibStart, sibEnd)
    expect(position).toBe('before')
    expect(videoTime).toBe(0)
  })

  it('handles partial overlap correctly within the overlap window', () => {
    // Primary 2020–2022, sibling 2021–2023. A date in 2021 is inside both.
    const sibStart = new Date('2021-01-01T00:00:00Z')
    const sibEnd = new Date('2023-01-01T00:00:00Z')
    // 2021-07-02 is ~25% through the sibling's 2-year range.
    const inOverlap = new Date('2021-07-02T12:00:00Z')
    const { videoTime, position } = dateToVideoTime(inOverlap, 100, sibStart, sibEnd)
    expect(position).toBe('inside')
    expect(videoTime).toBeGreaterThan(24)
    expect(videoTime).toBeLessThan(26)
  })
})

// ---------------------------------------------------------------------------
// computeSiblingSyncCorrection — multi-viewport drift correction (#132)
// ---------------------------------------------------------------------------
describe('computeSiblingSyncCorrection', () => {
  // The Climate Futures tour: all panels share 2015–2100 (85y) coverage.
  const start = new Date('2015-12-31T00:00:00Z')
  const end = new Date('2100-12-31T00:00:00Z')
  const rangeMs = end.getTime() - start.getTime()

  it('identical-range sibling of equal duration tracks the primary 1:1', () => {
    // Primary at the midpoint of a 30s video → date ≈ 2058.
    const mid = new Date((start.getTime() + end.getTime()) / 2)
    const c = computeSiblingSyncCorrection({
      date: mid,
      sibCurrentTime: 15, // already at the midpoint of its own 30s video
      sibDuration: 30,
      sibStart: start,
      sibEnd: end,
      primaryDuration: 30,
      primaryRangeMs: rangeMs,
      hardSeekThresholdS: 0.15,
    })
    expect(c.position).toBe('inside')
    expect(c.rate).toBeCloseTo(1, 5)
    expect(c.targetTime).toBeCloseTo(15, 5)
    expect(c.shouldSeek).toBe(false)
  })

  it('flags a seek once drift exceeds the threshold', () => {
    const mid = new Date((start.getTime() + end.getTime()) / 2)
    // Sibling has drifted to 15.5s while the target is 15s → 0.5s > 0.15s.
    const c = computeSiblingSyncCorrection({
      date: mid,
      sibCurrentTime: 15.5,
      sibDuration: 30,
      sibStart: start,
      sibEnd: end,
      primaryDuration: 30,
      primaryRangeMs: rangeMs,
      hardSeekThresholdS: 0.15,
    })
    expect(c.shouldSeek).toBe(true)
    expect(c.targetTime).toBeCloseTo(15, 5)
  })

  it('does not flag a seek for sub-threshold drift', () => {
    const mid = new Date((start.getTime() + end.getTime()) / 2)
    const c = computeSiblingSyncCorrection({
      date: mid,
      sibCurrentTime: 15.1, // 0.1s < 0.15s
      sibDuration: 30,
      sibStart: start,
      sibEnd: end,
      primaryDuration: 30,
      primaryRangeMs: rangeMs,
      hardSeekThresholdS: 0.15,
    })
    expect(c.shouldSeek).toBe(false)
  })

  it('maps to a fractional target when sibling duration differs from primary', () => {
    // Same date range, but the sibling video is encoded at 60s vs 30s.
    // The correct target is fraction-based (midpoint → 30s), not a raw
    // currentTime copy — this is why issue #132 option 3 ("copy
    // currentTime") is only safe when durations match.
    const mid = new Date((start.getTime() + end.getTime()) / 2)
    const c = computeSiblingSyncCorrection({
      date: mid,
      sibCurrentTime: 0,
      sibDuration: 60,
      sibStart: start,
      sibEnd: end,
      primaryDuration: 30,
      primaryRangeMs: rangeMs,
      hardSeekThresholdS: 0.15,
    })
    expect(c.targetTime).toBeCloseTo(30, 5)
    expect(c.rate).toBeCloseTo(2, 5) // 60s sib / 30s primary over equal range
    expect(c.shouldSeek).toBe(true)
  })

  it('paces a shorter-range sibling faster than the primary', () => {
    // Sibling covers half the real-world span in the same video seconds.
    const sibStart = new Date('2015-12-31T00:00:00Z')
    const sibEnd = new Date('2058-06-30T00:00:00Z') // ~half of 85y
    const dateInBoth = new Date('2030-01-01T00:00:00Z')
    const c = computeSiblingSyncCorrection({
      date: dateInBoth,
      sibCurrentTime: 0,
      sibDuration: 30,
      sibStart,
      sibEnd,
      primaryDuration: 30,
      primaryRangeMs: rangeMs,
      hardSeekThresholdS: 0.15,
    })
    expect(c.position).toBe('inside')
    // sibRange ≈ rangeMs/2 → rate ≈ 2× so it advances through its
    // (shorter) timeline at the primary's real-world pace.
    expect(c.rate).toBeGreaterThan(1.9)
    expect(c.rate).toBeLessThan(2.1)
  })

  it('reports position before/after when the primary date is outside the sibling range', () => {
    const sibStart = new Date('2050-01-01T00:00:00Z')
    const sibEnd = new Date('2100-12-31T00:00:00Z')
    const before = computeSiblingSyncCorrection({
      date: new Date('2030-01-01T00:00:00Z'),
      sibCurrentTime: 5,
      sibDuration: 30,
      sibStart,
      sibEnd,
      primaryDuration: 30,
      primaryRangeMs: rangeMs,
      hardSeekThresholdS: 0.15,
    })
    expect(before.position).toBe('before')
    expect(before.targetTime).toBe(0)
    expect(before.shouldSeek).toBe(true) // currentTime 5 → boundary 0

    const after = computeSiblingSyncCorrection({
      date: new Date('2100-12-31T00:00:00Z'),
      sibCurrentTime: 30,
      sibDuration: 30,
      sibStart: new Date('2015-12-31T00:00:00Z'),
      sibEnd: new Date('2058-06-30T00:00:00Z'),
      primaryDuration: 30,
      primaryRangeMs: rangeMs,
      hardSeekThresholdS: 0.15,
    })
    expect(after.position).toBe('after')
    expect(after.targetTime).toBe(30) // clamped to sibling duration
  })

  it('clamps an extreme high rate to the browser-honoured range', () => {
    // A sibling covering a tiny real-world window in a full-length video
    // would have to race through its timeline to keep the primary's
    // real-world pace; the unclamped rate is absurd, so clamp to MAX.
    const sibStart = new Date('2015-12-31T00:00:00Z')
    const sibEnd = new Date('2016-01-01T00:00:00Z') // 1 day in 30s
    const c = computeSiblingSyncCorrection({
      date: new Date('2015-12-31T12:00:00Z'),
      sibCurrentTime: 0,
      sibDuration: 30,
      sibStart,
      sibEnd,
      primaryDuration: 30,
      primaryRangeMs: rangeMs,
      hardSeekThresholdS: 0.15,
    })
    expect(c.rate).toBe(MAX_PLAYBACK_RATE)
    expect(c.rate).toBeGreaterThanOrEqual(MIN_PLAYBACK_RATE)
    expect(c.rate).toBeLessThanOrEqual(MAX_PLAYBACK_RATE)
  })

  it('falls back to rate 1 when a duration or range is degenerate', () => {
    const c = computeSiblingSyncCorrection({
      date: start,
      sibCurrentTime: 0,
      sibDuration: 0,
      sibStart: start,
      sibEnd: end,
      primaryDuration: 30,
      primaryRangeMs: rangeMs,
      hardSeekThresholdS: 0.15,
    })
    expect(c.rate).toBe(1)
  })

  // --- soft-sync controller (terraviz#229 flicker fix) ---

  const mid = () => new Date((start.getTime() + end.getTime()) / 2) // → target ≈ 15s of a 30s video

  it('eases a slightly-ahead sibling by trimming the rate down, without seeking', () => {
    const c = computeSiblingSyncCorrection({
      date: mid(),
      sibCurrentTime: 15.1, // 0.1s ahead of the 15s target
      sibDuration: 30,
      sibStart: start,
      sibEnd: end,
      primaryDuration: 30,
      primaryRangeMs: rangeMs,
      hardSeekThresholdS: 0.5,
    })
    expect(c.shouldSeek).toBe(false)
    expect(c.rate).toBeLessThan(1)
    // base 1 × (1 − 0.5·0.1) = 0.95
    expect(c.rate).toBeCloseTo(0.95, 5)
  })

  it('eases a slightly-behind sibling by trimming the rate up, without seeking', () => {
    const c = computeSiblingSyncCorrection({
      date: mid(),
      sibCurrentTime: 14.9, // 0.1s behind
      sibDuration: 30,
      sibStart: start,
      sibEnd: end,
      primaryDuration: 30,
      primaryRangeMs: rangeMs,
      hardSeekThresholdS: 0.5,
    })
    expect(c.shouldSeek).toBe(false)
    expect(c.rate).toBeGreaterThan(1)
    expect(c.rate).toBeCloseTo(1.05, 5)
  })

  it('caps the rate trim for a large-but-sub-hard-seek error', () => {
    const c = computeSiblingSyncCorrection({
      date: mid(),
      sibCurrentTime: 20, // 5s ahead, but under a generous hard-seek threshold
      sibDuration: 30,
      sibStart: start,
      sibEnd: end,
      primaryDuration: 30,
      primaryRangeMs: rangeMs,
      hardSeekThresholdS: 10,
    })
    expect(c.shouldSeek).toBe(false)
    // trim capped at 25% → rate = 1 × (1 − 0.25) = 0.75
    expect(c.rate).toBeCloseTo(0.75, 5)
  })

  it('scales the rate by the primary playback speed (tour 5fps → 0.167x)', () => {
    // Identical range/duration siblings: pacing ratio is 1, so the
    // sibling must run at the primary's actual speed, not 1x — otherwise
    // it races ahead and the hard-seek snaps it back (the #229 flicker).
    const c = computeSiblingSyncCorrection({
      date: mid(),
      sibCurrentTime: 15, // aligned, no drift
      sibDuration: 30,
      sibStart: start,
      sibEnd: end,
      primaryDuration: 30,
      primaryRangeMs: rangeMs,
      primaryPlaybackRate: 5 / 30, // ≈ 0.167x
      hardSeekThresholdS: 0.5,
    })
    expect(c.shouldSeek).toBe(false)
    expect(c.rate).toBeCloseTo(5 / 30, 5)
  })

  it('defaults primaryPlaybackRate to 1x when omitted', () => {
    const c = computeSiblingSyncCorrection({
      date: mid(),
      sibCurrentTime: 15,
      sibDuration: 30,
      sibStart: start,
      sibEnd: end,
      primaryDuration: 30,
      primaryRangeMs: rangeMs,
      hardSeekThresholdS: 0.5,
    })
    expect(c.rate).toBeCloseTo(1, 5)
  })

  it('hard-seeks (no trim) once in-range drift exceeds the hard-seek threshold', () => {
    const c = computeSiblingSyncCorrection({
      date: mid(),
      sibCurrentTime: 16, // 1s ahead of target, over the 0.5s hard threshold
      sibDuration: 30,
      sibStart: start,
      sibEnd: end,
      primaryDuration: 30,
      primaryRangeMs: rangeMs,
      hardSeekThresholdS: 0.5,
    })
    expect(c.shouldSeek).toBe(true)
    expect(c.targetTime).toBeCloseTo(15, 5)
    expect(c.rate).toBeCloseTo(1, 5) // untrimmed pacing rate
  })

  // --- the loop wrap ---

  it('sends a sibling parked at its own end home when the primary has wrapped', () => {
    // The wrap: the primary has looped back to the start of its range
    // while the sibling is still sitting at the end of its own video —
    // the state `seekSiblingsToDate` leaves it in when the auto-loop
    // pauses the primary a hair short of `duration`.
    const c = computeSiblingSyncCorrection({
      date: start,          // primary wrapped to the beginning of the range
      sibCurrentTime: 30,   // sibling still parked at the end of its video
      sibDuration: 30,
      sibStart: start,
      sibEnd: end,
      primaryDuration: 30,
      primaryRangeMs: rangeMs,
      hardSeekThresholdS: 0.5,
    })
    // The control law was never the problem: the desync is a whole video
    // duration, so it asks for a hard seek back to the start. What used
    // to go wrong is that the caller's `readyState` guard skipped the
    // sibling before this ever ran — see SIBLING_MIN_READY_STATE.
    expect(c.position).toBe('inside')
    expect(c.targetTime).toBeCloseTo(0, 5)
    expect(c.shouldSeek).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// SIBLING_SEEK_EPS_S — a seek not worth issuing
// ---------------------------------------------------------------------------
describe('SIBLING_SEEK_EPS_S', () => {
  // From a browser capture: four panels aligned at 0.5820 of a ~29s
  // clip, pressing play moved the siblings to 0.5822 and cost five
  // seconds of frozen panel. That move is this many seconds of video:
  const POINTLESS_MOVE_S = 0.0002 * 29
  const ONE_FRAME_AT_30FPS_S = 1 / 30

  it('forgives a move smaller than the one that cost five seconds', () => {
    expect(POINTLESS_MOVE_S).toBeLessThan(SIBLING_SEEK_EPS_S)
  })

  it('stays under a frame, so a skipped seek never changes what is shown', () => {
    // The panel must still land on the frame it would have seeked to;
    // the epsilon buys nothing if it can straddle two frames.
    expect(SIBLING_SEEK_EPS_S).toBeLessThan(ONE_FRAME_AT_30FPS_S)
  })
})

// ---------------------------------------------------------------------------
// SIBLING_HARD_SEEK_THRESHOLD_S — pinned to two measured numbers
// ---------------------------------------------------------------------------
describe('SIBLING_HARD_SEEK_THRESHOLD_S', () => {
  // Both figures come from a browser capture of a 4-globe Climate
  // Futures session: ~29s clips over 85 model years, sampled at 2 Hz.
  const STEADY_STATE_DRIFT_S = 0.026
  const POST_STALL_OFFSET_S = 0.35

  const start = new Date('2015-12-31T00:00:00Z')
  const end = new Date('2100-12-31T00:00:00Z')
  const rangeMs = end.getTime() - start.getTime()
  const mid = () => new Date((start.getTime() + end.getTime()) / 2)

  const atDrift = (driftS: number) => computeSiblingSyncCorrection({
    date: mid(),
    sibCurrentTime: 15 - driftS,   // behind by driftS on a 30s video
    sibDuration: 30,
    sibStart: start,
    sibEnd: end,
    primaryDuration: 30,
    primaryRangeMs: rangeMs,
    hardSeekThresholdS: SIBLING_HARD_SEEK_THRESHOLD_S,
  })

  it('leaves steady-state drift to the rate trim', () => {
    // Seeking here is the per-frame flicker terraviz#229 fixed. The
    // threshold has to stay clear of what normal playback produces.
    const c = atDrift(STEADY_STATE_DRIFT_S)
    expect(c.shouldSeek).toBe(false)
    expect(c.rate).toBeGreaterThan(1)   // trimmed up to catch back up
  })

  it('snaps out the offset a post-scrub buffering stall leaves', () => {
    // ~2s at HAVE_METADATA while the primary keeps playing. Under the
    // old 0.5s threshold this fell to the trim, which closes it at
    // ~0.029 s/s — about twelve seconds of staggered globes.
    expect(atDrift(POST_STALL_OFFSET_S).shouldSeek).toBe(true)
  })

  it('keeps usable margin on both sides rather than sitting near either', () => {
    // A threshold that merely separates the two numbers would be one
    // slow device away from being wrong in either direction.
    expect(SIBLING_HARD_SEEK_THRESHOLD_S).toBeGreaterThan(STEADY_STATE_DRIFT_S * 3)
    expect(SIBLING_HARD_SEEK_THRESHOLD_S).toBeLessThan(POST_STALL_OFFSET_S / 2)
  })
})

// ---------------------------------------------------------------------------
// SIBLING_MIN_READY_STATE
// ---------------------------------------------------------------------------
describe('SIBLING_MIN_READY_STATE', () => {
  // Mirrors the HTMLMediaElement constants, which jsdom does not expose
  // on a bare object.
  const HAVE_NOTHING = 0, HAVE_METADATA = 1, HAVE_CURRENT_DATA = 2

  it('admits a sibling as soon as metadata is known', () => {
    expect(SIBLING_MIN_READY_STATE).toBe(HAVE_METADATA)
  })

  it('still excludes HAVE_NOTHING, where duration is NaN', () => {
    expect(HAVE_NOTHING).toBeLessThan(SIBLING_MIN_READY_STATE)
  })

  // Regression tripwire. Raising this to HAVE_CURRENT_DATA is what caused
  // the multi-globe loop-wrap stall: a MediaSource-backed sibling seeked
  // to within a segment of its buffered end sits at HAVE_METADATA
  // indefinitely, and the sync paths would skip it at precisely the wrap,
  // leaving the panel frozen. If you are about to change this line,
  // read the doc comment on the constant first.
  it('never requires frame data the corrective seek would itself fetch', () => {
    expect(SIBLING_MIN_READY_STATE).toBeLessThan(HAVE_CURRENT_DATA)
  })
})

// ---------------------------------------------------------------------------
// shownFrameTime — what the panel is showing, not what its element says
// ---------------------------------------------------------------------------
describe('shownFrameTime', () => {
  it('prefers the frame that actually reached the texture', () => {
    // The case this exists for: a seek reads its target back instantly
    // while the element is still buffering, so `currentTime` claims a
    // position whose frame is not on screen.
    expect(shownFrameTime(12.5, 18.0)).toBe(12.5)
  })

  it('falls back to currentTime when nothing has been uploaded yet', () => {
    expect(shownFrameTime(null, 18.0)).toBe(18.0)
    expect(shownFrameTime(undefined, 18.0)).toBe(18.0)
  })

  it('keeps a legitimate zero rather than treating it as absent', () => {
    // The first frame of a dataset is a real answer; a falsy check here
    // would silently report the element's clock instead.
    expect(shownFrameTime(0, 18.0)).toBe(0)
  })

  it('rejects a non-finite recording', () => {
    expect(shownFrameTime(NaN, 18.0)).toBe(18.0)
    expect(shownFrameTime(Infinity, 18.0)).toBe(18.0)
  })
})

// ---------------------------------------------------------------------------
// verifySiblingTime — does a panel show the date the label claims?
// ---------------------------------------------------------------------------
describe('verifySiblingTime', () => {
  // A 60-hour range across a 2.033s / 61-frame clip: the 4-globe tour
  // shape, where one frame is very nearly one hour of real-world time.
  const start = new Date('2026-03-01T00:00:00Z')
  const end = new Date('2026-03-03T12:00:00Z')
  const DUR = 61 / 30
  const HOUR = 60 * 60 * 1000

  const at = (videoTime: number, over = { start, end, dur: DUR }) =>
    new Date(over.start.getTime()
      + (videoTime / over.dur) * (over.end.getTime() - over.start.getTime()))

  it('accepts a sibling sitting on the labelled moment', () => {
    const v = verifySiblingTime({
      labelDate: at(1), sibFrameTime: 1, sibDuration: DUR,
      sibStart: start, sibEnd: end, snapIntervalMs: HOUR,
    })
    expect(v.alignment).toBe('aligned')
    expect(v.driftMs).toBe(0)
  })

  it('accepts sub-frame slop from the browser snapping a seek', () => {
    // A seek lands on the nearest decodable frame rather than exactly
    // where it was asked to; that must not read as a mismatch.
    const v = verifySiblingTime({
      labelDate: at(1), sibFrameTime: 1 + (1 / 30) * 0.4, sibDuration: DUR,
      sibStart: start, sibEnd: end, snapIntervalMs: HOUR,
    })
    expect(v.alignment).toBe('aligned')
  })

  it('flags the loop-wrap stall: label at the start, panel still at the end', () => {
    // The failure this exists to catch — the label reads the wrap
    // position while the sibling is stranded at its own last frame.
    const v = verifySiblingTime({
      labelDate: start, sibFrameTime: DUR, sibDuration: DUR,
      sibStart: start, sibEnd: end, snapIntervalMs: HOUR,
    })
    expect(v.alignment).toBe('off')
    expect(v.shownDate.getTime()).toBe(end.getTime())
    expect(v.driftMs).toBe(end.getTime() - start.getTime())
  })

  it('signs the drift so a caller can tell ahead from behind', () => {
    const ahead = verifySiblingTime({
      labelDate: at(1), sibFrameTime: 1.5, sibDuration: DUR,
      sibStart: start, sibEnd: end, snapIntervalMs: HOUR,
    })
    const behind = verifySiblingTime({
      labelDate: at(1), sibFrameTime: 0.5, sibDuration: DUR,
      sibStart: start, sibEnd: end, snapIntervalMs: HOUR,
    })
    expect(ahead.driftMs).toBeGreaterThan(0)
    expect(behind.driftMs).toBeLessThan(0)
    expect(ahead.alignment).toBe('off')
    expect(behind.alignment).toBe('off')
  })

  it('reports uncovered rather than off when the range misses the label', () => {
    // The panel is pinned to a boundary frame on purpose and already
    // says so through the out-of-range treatment; calling that a
    // mismatch would explain one state twice in two vocabularies.
    const before = verifySiblingTime({
      labelDate: new Date('2026-02-01T00:00:00Z'),
      sibFrameTime: 0, sibDuration: DUR,
      sibStart: start, sibEnd: end, snapIntervalMs: HOUR,
    })
    expect(before.alignment).toBe('uncovered')

    const after = verifySiblingTime({
      labelDate: new Date('2026-04-01T00:00:00Z'),
      sibFrameTime: DUR, sibDuration: DUR,
      sibStart: start, sibEnd: end, snapIntervalMs: HOUR,
    })
    expect(after.alignment).toBe('uncovered')
  })

  it('compares against the displayed step, not raw milliseconds', () => {
    // Both dates snap to the same hour, so the panels display the same
    // label and the assertion the label makes is true.
    const v = verifySiblingTime({
      labelDate: new Date('2026-03-01T04:00:00Z'),
      sibFrameTime: (4 * HOUR / (end.getTime() - start.getTime())) * DUR + 0.001,
      sibDuration: DUR, sibStart: start, sibEnd: end, snapIntervalMs: HOUR,
    })
    expect(v.toleranceMs).toBe(HOUR / 2)
    expect(v.alignment).toBe('aligned')
  })

  it('does not call a two-minute difference an hour apart at a bucket edge', () => {
    // The label's instant and the panel's straddle an hour boundary two
    // minutes apart. Snapping both to the label's grid and comparing
    // buckets — the obvious implementation — reads that as a full hour
    // of disagreement. They are the same frame.
    const videoTimeFor = (d: Date) =>
      ((d.getTime() - start.getTime()) / (end.getTime() - start.getTime())) * DUR
    const v = verifySiblingTime({
      labelDate: new Date('2026-03-01T03:29:00Z'),
      sibFrameTime: videoTimeFor(new Date('2026-03-01T03:31:00Z')),
      sibDuration: DUR, sibStart: start, sibEnd: end, snapIntervalMs: HOUR,
    })
    expect(Math.abs(v.driftMs - 2 * 60 * 1000)).toBeLessThan(1000)
    expect(v.alignment).toBe('aligned')
    // The date it would show is still snapped, so a notice reads in the
    // same vocabulary as the label it contradicts.
    expect(v.shownDate.toISOString()).toBe('2026-03-01T04:00:00.000Z')
  })

  it('falls back to one video frame of real time with no display cadence', () => {
    const v = verifySiblingTime({
      labelDate: at(1), sibFrameTime: 1, sibDuration: DUR,
      sibStart: start, sibEnd: end,
    })
    // 60 hours over 2.033s of video → one 1/30s frame is ~59 minutes.
    expect(v.toleranceMs).toBeGreaterThan(55 * 60 * 1000)
    expect(v.toleranceMs).toBeLessThan(60 * 60 * 1000)
    expect(v.alignment).toBe('aligned')
  })

  it('maps through each panel\'s own duration, not the primary\'s', () => {
    // A sibling encoded at twice the length covers the same range, so
    // the same real-world date sits at twice the video time. Comparing
    // raw currentTime across panels would call this a mismatch.
    const v = verifySiblingTime({
      labelDate: at(1), sibFrameTime: 2, sibDuration: DUR * 2,
      sibStart: start, sibEnd: end, snapIntervalMs: HOUR,
    })
    expect(v.alignment).toBe('aligned')
  })
})

// ---------------------------------------------------------------------------
// inferDisplayInterval
// ---------------------------------------------------------------------------
describe('inferDisplayInterval', () => {
  it('chooses 15min interval for a high-fps short range', () => {
    const start = new Date('2020-01-01T00:00:00Z')
    const end = new Date('2020-01-01T01:00:00Z') // 1 hour
    // 60s video at 30fps = 1800 frames → 3600000ms / 1800 = 2000ms/frame → pick 15min
    const { intervalMs, showTime } = inferDisplayInterval(start, end, 60, 30)
    expect(intervalMs).toBe(15 * 60 * 1000)
    expect(showTime).toBe(true)
  })

  it('chooses 1d interval for a multi-year low-fps range', () => {
    const start = new Date('2000-01-01T00:00:00Z')
    const end = new Date('2020-01-01T00:00:00Z') // 20 years
    // 60s at 1fps = 60 frames, huge ms/frame → pick 1M, but test just that it's >= 1d
    const { intervalMs } = inferDisplayInterval(start, end, 60, 1)
    expect(intervalMs).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000)
  })

  it('sets showTime=false for daily or coarser intervals', () => {
    const start = new Date('2020-01-01T00:00:00Z')
    const end = new Date('2021-01-01T00:00:00Z') // 1 year
    const { showTime } = inferDisplayInterval(start, end, 60, 1)
    expect(showTime).toBe(false)
  })

  // -------------------------------------------------------------
  // Phase 3 §5.1 — frame/label sync fix
  // -------------------------------------------------------------

  it('uses Phase 3pg frameCount when available for exact cadence', () => {
    // 30 frames spanning 30 years → 1 year per frame, exactly.
    const start = new Date('1990-01-01T00:00:00Z')
    const end = new Date('2020-01-01T00:00:00Z')
    const { intervalMs, showTime } = inferDisplayInterval(start, end, 60, { frameCount: 30 })
    const oneYearMs = 365.25 * 24 * 60 * 60 * 1000
    // Calendar years vary slightly; allow a small tolerance for
    // leap days.
    expect(intervalMs).toBeGreaterThan(oneYearMs * 0.99)
    expect(intervalMs).toBeLessThan(oneYearMs * 1.05)
    expect(showTime).toBe(false)
  })

  it('uses period when no frameCount is provided (P1Y → yearly)', () => {
    const start = new Date('1990-01-01T00:00:00Z')
    const end = new Date('2020-01-01T00:00:00Z')
    const { intervalMs, showTime } = inferDisplayInterval(start, end, 60, { period: 'P1Y' })
    const oneYearMs = 365.25 * 24 * 60 * 60 * 1000
    expect(intervalMs).toBeCloseTo(oneYearMs, -3) // within ~1s
    expect(showTime).toBe(false)
  })

  it('uses period for sub-daily cadences (PT6H → 6 hours)', () => {
    const start = new Date('2020-01-01T00:00:00Z')
    const end = new Date('2020-01-08T00:00:00Z')
    const { intervalMs, showTime } = inferDisplayInterval(start, end, 60, { period: 'PT6H' })
    expect(intervalMs).toBe(6 * 60 * 60 * 1000)
    expect(showTime).toBe(true)
  })

  it('falls through to the legacy snap path when period is unparseable', () => {
    // Garbage period — the function should swallow the parse error
    // and pick a snap interval from the legacy ms-per-frame
    // computation instead of throwing.
    const start = new Date('2020-01-01T00:00:00Z')
    const end = new Date('2020-01-01T01:00:00Z')
    const { intervalMs } = inferDisplayInterval(start, end, 60, { period: 'not-a-duration', fps: 30 })
    expect(intervalMs).toBe(15 * 60 * 1000)
  })

  it('prefers frameCount over period when both are provided', () => {
    const start = new Date('1990-01-01T00:00:00Z')
    const end = new Date('2020-01-01T00:00:00Z')
    const { intervalMs } = inferDisplayInterval(start, end, 60, {
      frameCount: 60,    // 30 years / 60 frames = 6 months per frame
      period: 'P1Y',     // claims yearly — frameCount wins
    })
    const sixMonthsMs = 6 * 30.44 * 24 * 60 * 60 * 1000
    expect(intervalMs).toBeGreaterThan(sixMonthsMs * 0.9)
    expect(intervalMs).toBeLessThan(sixMonthsMs * 1.1)
  })

  it('snap list now extends past 1 month for multi-year ranges', () => {
    // The bug Beth + Hilary flagged: a 30-frame / 30-year dataset
    // used to clamp to 1M because the snap list topped out there,
    // giving 12 label ticks per imagery frame. With the extended
    // list, msPerFrame ~ 1 year now lands on the 1Y snap.
    const start = new Date('1990-01-01T00:00:00Z')
    const end = new Date('2020-01-01T00:00:00Z')
    // 30s video at 1 fps = 30 frames → msPerFrame = 1 year.
    const { intervalMs } = inferDisplayInterval(start, end, 30, 1)
    const oneMonthMs = 30.44 * 24 * 60 * 60 * 1000
    expect(intervalMs).toBeGreaterThan(oneMonthMs)
  })
})

// ---------------------------------------------------------------------------
// getSunPosition
// ---------------------------------------------------------------------------
describe('getSunPosition', () => {
  it('returns lat near 0 at equinox', () => {
    // Spring equinox ~March 21 = day ~80
    const equinox = new Date('2020-03-21T12:00:00Z')
    const { lat } = getSunPosition(equinox)
    expect(Math.abs(lat)).toBeLessThan(2)
  })

  it('returns lat near +23.44 at northern summer solstice', () => {
    const solstice = new Date('2020-06-21T12:00:00Z')
    const { lat } = getSunPosition(solstice)
    expect(lat).toBeCloseTo(23.44, 0)
  })

  it('returns lng ~0 at solar noon UTC', () => {
    // UTC noon → subsolar longitude should be near 0°
    const noon = new Date('2020-06-21T12:00:00Z')
    const { lng } = getSunPosition(noon)
    expect(Math.abs(lng)).toBeLessThan(1)
  })

  it('lng range is within ±180', () => {
    for (let h = 0; h < 24; h++) {
      const d = new Date(`2020-01-15T${String(h).padStart(2, '0')}:00:00Z`)
      const { lng } = getSunPosition(d)
      expect(lng).toBeGreaterThanOrEqual(-180)
      expect(lng).toBeLessThanOrEqual(180)
    }
  })
})
