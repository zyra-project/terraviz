import { describe, it, expect } from 'vitest'
import {
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
