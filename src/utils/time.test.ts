import { describe, it, expect } from 'vitest'
import {
  parseISO8601Duration,
  formatDuration,
  isSubDailyPeriod,
  calculateFrameDatetime,
  calculateFrameIndex,
  videoTimeToDate,
  dateToVideoTime,
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
