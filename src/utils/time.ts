/**
 * Time utilities for parsing and formatting temporal data
 */

// --- Time constants ---
const EARTH_AXIAL_TILT = 23.44
const SPRING_EQUINOX_DAY = 81
const DAYS_PER_YEAR = 365
const SOLAR_DEGREES_PER_HOUR = 15
const MINUTES_SNAP_INTERVAL = 10
const DAYS_PER_YEAR_APPROX = 365.25
const DAYS_PER_MONTH_APPROX = 30.44

/**
 * Parse ISO 8601 datetime string to Date or period object
 * Examples:
 *   "2015-01-08T12:00:00" -> Date
 *   "P1W" -> { type: 'week', days: 7 }
 *   "PT6H" -> { type: 'hour', days: 0.25 }
 */
export function parseISO8601Duration(value: string): Date | { type: string; days: number } {
  // Try parsing as ISO 8601 datetime first
  if (value.includes('T') && !value.startsWith('P')) {
    try {
      return new Date(value)
    } catch {
      // Fall through to duration parsing
    }
  }

  // Parse as ISO 8601 duration (e.g., P1W, PT6H, P1D)
  const durationRegex = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/
  const match = value.match(durationRegex)

  if (!match) {
    throw new Error(`Invalid ISO 8601 value: ${value}`)
  }

  const [, years, months, weeks, days, hours, minutes, seconds] = match
  let totalDays = 0

  if (years) totalDays += parseInt(years) * DAYS_PER_YEAR_APPROX
  if (months) totalDays += parseInt(months) * DAYS_PER_MONTH_APPROX
  if (weeks) totalDays += parseInt(weeks) * 7
  if (days) totalDays += parseInt(days)
  if (hours) totalDays += parseInt(hours) / 24
  if (minutes) totalDays += parseInt(minutes) / (24 * 60)
  if (seconds) totalDays += parseFloat(seconds) / (24 * 60 * 60)

  // Determine period type
  let type = 'custom'
  if (value === 'P1D') type = 'day'
  else if (value === 'P1W') type = 'week'
  else if (value === 'P1M') type = 'month'
  else if (value === 'P1Y') type = 'year'
  else if (value === 'PT1H') type = 'hour'
  else if (value === 'PT15M') type = 'minute'

  return { type, days: totalDays }
}

/**
 * Format a date for display
 */
export function formatDate(date: Date, includeTime = false): string {
  if (includeTime) {
    // Snap minutes to nearest 10
    const snapped = new Date(date)
    snapped.setMinutes(Math.round(snapped.getMinutes() / MINUTES_SNAP_INTERVAL) * MINUTES_SNAP_INTERVAL, 0, 0)
    return snapped.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  }
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

/**
 * Check if a dataset period is sub-daily (hours, minutes, etc.)
 */
export function isSubDailyPeriod(period: string | undefined | null): boolean {
  if (!period) return false
  // Sub-daily periods contain 'T' followed by H, M, or S (e.g. PT6H, PT15M)
  return /^PT/.test(period)
}

/**
 * Calculate actual datetime from frame index and temporal metadata
 */
export function calculateFrameDatetime(
  frameIndex: number,
  totalFrames: number,
  startTime: Date,
  endTime: Date,
  period?: { type: string; days: number }
): Date {
  const totalMs = endTime.getTime() - startTime.getTime()
  const msPerFrame = totalMs / (totalFrames - 1)
  const offsetMs = frameIndex * msPerFrame
  return new Date(startTime.getTime() + offsetMs)
}

/**
 * Calculate frame index from a target date
 */
export function calculateFrameIndex(
  targetDate: Date,
  startTime: Date,
  endTime: Date,
  totalFrames: number
): number {
  const totalMs = endTime.getTime() - startTime.getTime()
  const offsetMs = targetDate.getTime() - startTime.getTime()
  const frameIndex = Math.round((offsetMs / totalMs) * (totalFrames - 1))
  return Math.max(0, Math.min(totalFrames - 1, frameIndex))
}

/**
 * Map video playback time to a real-world date, given dataset temporal range.
 * Optionally snaps to the nearest interval boundary.
 */
export function videoTimeToDate(
  videoTime: number,
  videoDuration: number,
  startTime: Date,
  endTime: Date,
  snapIntervalMs?: number
): Date {
  if (videoDuration <= 0) return startTime
  const fraction = Math.min(1, Math.max(0, videoTime / videoDuration))
  const totalMs = endTime.getTime() - startTime.getTime()
  const rawMs = startTime.getTime() + fraction * totalMs

  if (snapIntervalMs && snapIntervalMs > 0) {
    const snapped = Math.round(rawMs / snapIntervalMs) * snapIntervalMs
    return new Date(Math.max(startTime.getTime(), Math.min(endTime.getTime(), snapped)))
  }

  return new Date(rawMs)
}

/**
 * Map a real-world date to the corresponding video playback time in a
 * dataset's temporal range — the inverse of {@link videoTimeToDate}.
 *
 * Returns an object describing whether the date falls inside the
 * dataset's range, and the clamped `videoTime` that represents it:
 *
 * - `position: 'inside'`  — date is within `[startTime, endTime]`
 * - `position: 'before'`  — date is before `startTime`; `videoTime` is 0
 * - `position: 'after'`   — date is after `endTime`;   `videoTime` is clamped to `videoDuration`
 *
 * Callers driving multi-panel playback sync use this to seek sibling
 * videos to match the primary's real-world date, and use the
 * `position` field to freeze out-of-range panels at their nearest
 * boundary and mark them visually.
 */
export function dateToVideoTime(
  date: Date,
  videoDuration: number,
  startTime: Date,
  endTime: Date,
): { videoTime: number; position: 'before' | 'inside' | 'after' } {
  if (videoDuration <= 0) {
    return { videoTime: 0, position: 'inside' }
  }
  const dateMs = date.getTime()
  const startMs = startTime.getTime()
  const endMs = endTime.getTime()
  if (dateMs < startMs) {
    return { videoTime: 0, position: 'before' }
  }
  if (dateMs > endMs) {
    return { videoTime: videoDuration, position: 'after' }
  }
  const totalMs = endMs - startMs
  if (totalMs <= 0) {
    return { videoTime: 0, position: 'inside' }
  }
  const fraction = (dateMs - startMs) / totalMs
  return { videoTime: fraction * videoDuration, position: 'inside' }
}

/** Standard snap intervals in ascending order of size */
const SNAP_INTERVALS = [
  { label: '15min', ms: 15 * 60 * 1000 },
  { label: '30min', ms: 30 * 60 * 1000 },
  { label: '1h',    ms: 60 * 60 * 1000 },
  { label: '3h',    ms: 3 * 60 * 60 * 1000 },
  { label: '6h',    ms: 6 * 60 * 60 * 1000 },
  { label: '12h',   ms: 12 * 60 * 60 * 1000 },
  { label: '1d',    ms: 24 * 60 * 60 * 1000 },
  { label: '1w',    ms: 7 * 24 * 60 * 60 * 1000 },
  { label: '1M',    ms: DAYS_PER_MONTH_APPROX * 24 * 60 * 60 * 1000 },
]

/**
 * Infer a display interval from the dataset time range and video duration.
 * Returns the interval in milliseconds and whether time-of-day should be shown.
 */
export function inferDisplayInterval(
  startTime: Date,
  endTime: Date,
  videoDuration: number,
  fps = 30
): { intervalMs: number; showTime: boolean } {
  const totalMs = endTime.getTime() - startTime.getTime()
  const totalFrames = videoDuration * fps
  const msPerFrame = totalMs / totalFrames

  // Pick the smallest snap interval that is >= msPerFrame
  // so each step visibly advances the label
  let chosen = SNAP_INTERVALS[SNAP_INTERVALS.length - 1]
  for (const snap of SNAP_INTERVALS) {
    if (snap.ms >= msPerFrame) {
      chosen = snap
      break
    }
  }

  const showTime = chosen.ms < 24 * 60 * 60 * 1000
  return { intervalMs: chosen.ms, showTime }
}

/**
 * Compute the subsolar point (lat/lng where the sun is directly overhead)
 * for a given UTC date using simplified solar position equations.
 */
export function getSunPosition(date: Date): { lat: number; lng: number } {
  const start = new Date(date.getFullYear(), 0, 0)
  const diff = date.getTime() - start.getTime()
  const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24))

  // Solar declination (axial tilt = 23.44°, spring equinox ≈ day 80)
  const declination = EARTH_AXIAL_TILT * Math.sin((2 * Math.PI / DAYS_PER_YEAR) * (dayOfYear - SPRING_EQUINOX_DAY))

  // Subsolar longitude from UTC time
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600
  const lng = (12 - utcHours) * SOLAR_DEGREES_PER_HOUR

  return { lat: declination, lng }
}

/**
 * Format seconds as mm:ss or hh:mm:ss
 */
export function formatDuration(seconds: number): string {
  const s = Math.floor(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  if (h > 0) return `${h}:${pad(m)}:${pad(sec)}`
  return `${m}:${pad(sec)}`
}
