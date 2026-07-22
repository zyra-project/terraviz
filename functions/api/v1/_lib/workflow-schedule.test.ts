import { describe, it, expect } from 'vitest'
import {
  advanceNextRunAt,
  computeNextRunAt,
  isValidSchedule,
  parseScheduleSeconds,
} from './workflow-schedule'

describe('parseScheduleSeconds', () => {
  it('parses the preset vocabulary', () => {
    expect(parseScheduleSeconds('PT15M')).toBe(900)
    expect(parseScheduleSeconds('PT1H')).toBe(3600)
    expect(parseScheduleSeconds('P1D')).toBe(86_400)
    expect(parseScheduleSeconds('P1W')).toBe(7 * 86_400)
    expect(parseScheduleSeconds('P1DT12H')).toBe(86_400 + 12 * 3600)
  })

  it('rejects calendar units, empties, and garbage', () => {
    expect(parseScheduleSeconds('P1M')).toBeNull() // months are calendar-fuzzy
    expect(parseScheduleSeconds('P1Y')).toBeNull()
    expect(parseScheduleSeconds('P')).toBeNull()
    expect(parseScheduleSeconds('PT')).toBeNull()
    expect(parseScheduleSeconds('P1DT')).toBeNull() // bare T is not valid ISO-8601
    expect(parseScheduleSeconds('1h')).toBeNull()
    expect(parseScheduleSeconds('')).toBeNull()
  })
})

describe('isValidSchedule', () => {
  it('enforces the tick floor and sanity ceiling', () => {
    expect(isValidSchedule('PT15M')).toBe(true)
    expect(isValidSchedule('PT14M')).toBe(false) // below the 15-min scheduler tick
    expect(isValidSchedule('P90D')).toBe(true)
    expect(isValidSchedule('P91D')).toBe(false)
  })
})

describe('computeNextRunAt', () => {
  it('adds the duration to now', () => {
    const now = new Date('2026-06-10T00:00:00.000Z')
    expect(computeNextRunAt('PT1H', now)).toBe('2026-06-10T01:00:00.000Z')
    expect(computeNextRunAt('P1D', now)).toBe('2026-06-11T00:00:00.000Z')
  })

  it('returns null for unparsable schedules', () => {
    expect(computeNextRunAt('soon')).toBeNull()
  })
})

describe('advanceNextRunAt', () => {
  const due = '2026-06-10T00:00:00.000Z'

  it('keeps the phase when dispatch is on time (cron-tick jitter)', () => {
    const now = new Date('2026-06-10T00:07:00.000Z')
    expect(advanceNextRunAt('P1D', due, now)).toBe('2026-06-11T00:00:00.000Z')
  })

  it('keeps the phase when dispatch is hours late (GHA schedule delay)', () => {
    const now = new Date('2026-06-10T02:13:00.000Z')
    expect(advanceNextRunAt('P1D', due, now)).toBe('2026-06-11T00:00:00.000Z')
  })

  it('skips missed slots in one jump when several periods behind', () => {
    const now = new Date('2026-06-13T05:00:00.000Z') // 3 periods + 5h late
    expect(advanceNextRunAt('P1D', due, now)).toBe('2026-06-14T00:00:00.000Z')
  })

  it('advances a full period past an exactly-due boundary', () => {
    const now = new Date(due)
    expect(advanceNextRunAt('P1D', due, now)).toBe('2026-06-11T00:00:00.000Z')
  })

  it('still moves forward under clock skew (now before due)', () => {
    const now = new Date('2026-06-09T23:58:00.000Z')
    expect(advanceNextRunAt('P1D', due, now)).toBe('2026-06-11T00:00:00.000Z')
  })

  it('falls back to now + period without a usable anchor', () => {
    const now = new Date('2026-06-10T00:07:00.000Z')
    expect(advanceNextRunAt('P1D', null, now)).toBe('2026-06-11T00:07:00.000Z')
    expect(advanceNextRunAt('P1D', 'not-a-date', now)).toBe('2026-06-11T00:07:00.000Z')
  })

  it('returns null for unparsable schedules', () => {
    expect(advanceNextRunAt('soon', due)).toBeNull()
  })

  it('returns null for zero-length durations instead of throwing', () => {
    expect(advanceNextRunAt('PT0S', due)).toBeNull()
    expect(advanceNextRunAt('P0D', due, new Date(due))).toBeNull()
  })
})
