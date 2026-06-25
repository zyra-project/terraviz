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

/**
 * Browser `HTMLMediaElement.playbackRate` is only honoured within a
 * limited range (commonly ~0.0625×–16×); values outside are clamped or
 * ignored. We clamp ourselves so the computed sibling rate stays in a
 * range the element will actually apply.
 */
export const MIN_PLAYBACK_RATE = 0.0625
export const MAX_PLAYBACK_RATE = 16

/**
 * Soft-sync controller gains for in-range siblings. Small drift is
 * corrected by gently trimming `playbackRate` rather than seeking —
 * a `currentTime` write on a *playing* video forces a decoder seek
 * (readyState dips, decode flushes) which is visible as a flicker when
 * it fires every frame. Easing the rate instead is imperceptible.
 *
 * - `SYNC_RATE_GAIN`: fraction of rate trim applied per second of drift
 *   error (0.5 ⇒ a 0.1 s lag → 5 % faster, closing in ~2 s).
 * - `SYNC_MAX_RATE_TRIM`: cap on that trim so a transient large error
 *   can't swing the rate wildly (±25 %).
 *
 * Errors larger than the caller's `hardSeekThresholdS` skip the trim and
 * hard-seek instead — a jump is unavoidable there (re-entry from
 * out-of-range, post-stall, scrub) and acceptable because it's rare.
 */
const SYNC_RATE_GAIN = 0.5
const SYNC_MAX_RATE_TRIM = 0.25

/**
 * How close (seconds) an out-of-range sibling must already be to its
 * boundary frame before we stop re-issuing the pinning seek. Smaller
 * than a video frame, so the frozen panel sits on its exact first/last
 * available frame, but non-zero so we don't rewrite `currentTime` every
 * frame once pinned.
 */
const BOUNDARY_PIN_EPS_S = 0.02

export interface SiblingSyncCorrection {
  /** Where the primary's date falls relative to the sibling's range. */
  position: 'before' | 'inside' | 'after'
  /** Video time (seconds) the sibling should be at to show the date. */
  targetTime: number
  /**
   * Playback rate to apply this frame. For an in-range sibling within
   * the hard-seek threshold this is the pacing rate gently trimmed to
   * ease out residual drift; otherwise it's the untrimmed pacing rate.
   * Clamped to the browser-honoured range.
   */
  rate: number
  /**
   * True when the sibling should be hard-seeked to `targetTime` this
   * frame: in-range drift beyond `hardSeekThresholdS`, or an
   * out-of-range sibling not yet pinned to its boundary frame.
   */
  shouldSeek: boolean
}

/**
 * Pure decision for a single sibling viewport in multi-panel playback
 * sync: given the primary's real-world `date` and both videos' temporal
 * ranges + durations, compute where the sibling *should* be, the
 * playback rate to apply, and whether to hard-seek this frame.
 *
 * Extracted from `correctSiblingDrift` (terraviz#132) so the control law
 * is unit-testable in isolation. The caller owns the actual
 * `currentTime` / `playbackRate` writes and play/pause state.
 *
 * Control strategy (terraviz#229 flicker fix): for an in-range sibling,
 * small drift is eased out by trimming the pacing rate (no seek, no
 * flicker); only drift beyond `hardSeekThresholdS` triggers a corrective
 * seek. Out-of-range siblings are pinned to their nearest boundary frame
 * (seek when not already within `BOUNDARY_PIN_EPS_S` of it).
 */
export function computeSiblingSyncCorrection(params: {
  date: Date
  sibCurrentTime: number
  sibDuration: number
  sibStart: Date
  sibEnd: Date
  primaryDuration: number
  primaryRangeMs: number
  hardSeekThresholdS: number
  /**
   * The primary video's *current* `playbackRate`. The pacing ratio
   * assumes the primary runs at 1×, so it must be scaled by the
   * primary's actual speed — otherwise, when a tour slows playback
   * (e.g. 5 fps → 0.167×, which sets only the primary's rate), the
   * sibling keeps running at the ~1× pacing ratio and races ahead until
   * a hard seek snaps it back, a visible flicker (terraviz#229).
   * Defaults to 1.
   */
  primaryPlaybackRate?: number
}): SiblingSyncCorrection {
  const { date, sibCurrentTime, sibDuration, sibStart, sibEnd, primaryDuration, primaryRangeMs, hardSeekThresholdS, primaryPlaybackRate = 1 } = params

  const { videoTime: targetTime, position } = dateToVideoTime(date, sibDuration, sibStart, sibEnd)

  // Base pacing rate: makes the sibling advance through real-world time
  // at the primary's pace even when ranges/durations differ.
  const sibRangeMs = sibEnd.getTime() - sibStart.getTime()
  let baseRate = 1
  if (primaryRangeMs > 0 && sibRangeMs > 0 && primaryDuration > 0 && sibDuration > 0) {
    // rate = (sib video seconds per real-world ms) / (primary video seconds per real-world ms)
    baseRate = (sibDuration / sibRangeMs) / (primaryDuration / primaryRangeMs)
  }
  // Scale by the primary's actual speed so the sibling tracks it through
  // tour playback-rate changes, not just at 1×.
  baseRate *= primaryPlaybackRate
  const clamp = (r: number) => Math.max(MIN_PLAYBACK_RATE, Math.min(MAX_PLAYBACK_RATE, r))

  if (position !== 'inside') {
    // Out-of-range: pin to the boundary frame; rate is moot (the caller
    // pauses out-of-range siblings) so leave it at the pacing rate.
    const shouldSeek = Math.abs(sibCurrentTime - targetTime) > BOUNDARY_PIN_EPS_S
    return { position, targetTime, rate: clamp(baseRate), shouldSeek }
  }

  // In-range. error > 0 ⇒ sibling is ahead of where it should be.
  const error = sibCurrentTime - targetTime

  if (Math.abs(error) > hardSeekThresholdS) {
    // Large desync — a jump is unavoidable; seek and run at the pacing rate.
    return { position, targetTime, rate: clamp(baseRate), shouldSeek: true }
  }

  // Small drift — ease it out by trimming the rate, no seek. Ahead →
  // slow down (rate < base); behind → speed up.
  const trim = Math.max(-SYNC_MAX_RATE_TRIM, Math.min(SYNC_MAX_RATE_TRIM, error * SYNC_RATE_GAIN))
  return { position, targetTime, rate: clamp(baseRate * (1 - trim)), shouldSeek: false }
}

/** Standard snap intervals in ascending order of size. The list
 *  extends past 1 month into seasonal and yearly steps — Phase 3
 *  fix for the climate-dataset bug Beth + Hilary flagged, where
 *  a 30-frame / 30-year dataset's `msPerFrame` (~1 year) used to
 *  fall off the top of this list and clamp to 1M, giving 12 label
 *  ticks per image. See `docs/WEB_CATALOG_FEATURES_PLAN.md` §5.1. */
const ONE_DAY_MS = 24 * 60 * 60 * 1000
const SNAP_INTERVALS = [
  { label: '15min', ms: 15 * 60 * 1000 },
  { label: '30min', ms: 30 * 60 * 1000 },
  { label: '1h',    ms: 60 * 60 * 1000 },
  { label: '3h',    ms: 3 * 60 * 60 * 1000 },
  { label: '6h',    ms: 6 * 60 * 60 * 1000 },
  { label: '12h',   ms: 12 * 60 * 60 * 1000 },
  { label: '1d',    ms: ONE_DAY_MS },
  { label: '1w',    ms: 7 * ONE_DAY_MS },
  { label: '1M',    ms: DAYS_PER_MONTH_APPROX * ONE_DAY_MS },
  { label: '3M',    ms: 3 * DAYS_PER_MONTH_APPROX * ONE_DAY_MS },
  { label: '6M',    ms: 6 * DAYS_PER_MONTH_APPROX * ONE_DAY_MS },
  { label: '1Y',    ms: DAYS_PER_YEAR_APPROX * ONE_DAY_MS },
  { label: '5Y',    ms: 5 * DAYS_PER_YEAR_APPROX * ONE_DAY_MS },
  { label: '10Y',   ms: 10 * DAYS_PER_YEAR_APPROX * ONE_DAY_MS },
]

/** Optional extras when inferring a display interval — both come
 *  from the dataset row itself, so callers that have the dataset
 *  in hand can pass them to get an imagery-accurate cadence. */
export interface DisplayIntervalOptions {
  /** ISO 8601 duration from `Dataset.period` — e.g. `P1Y`, `P1M`,
   *  `PT6H`. When parseable, the returned interval matches it
   *  exactly so the label cadence and the imagery cadence agree. */
  period?: string
  /** Exact frame count from the Phase 3pg `Dataset.frames.count`
   *  field (image-sequence rows). When present, the interval is
   *  derived from the total range and the frame count — the
   *  cleanest possible cadence since no inference is involved. */
  frameCount?: number
  /** Video FPS for the fallback ms-per-frame inference path.
   *  Ignored when `period` or `frameCount` resolves the cadence. */
  fps?: number
}

/**
 * Infer a display interval from the dataset time range and video
 * duration. Returns the interval in milliseconds and whether
 * time-of-day should be shown alongside the date.
 *
 * Cadence resolution order — best signal wins:
 *
 *   1. **Frame count** (Phase 3pg image-sequence rows).
 *      `(endTime − startTime) / (frameCount − 1)` is exact.
 *   2. **Period** (`Dataset.period`, ISO 8601 duration).
 *      Parsed via {@link parseISO8601Duration}; matches the
 *      curator's stated imagery cadence.
 *   3. **`videoDuration` × `fps`** fallback — picks the smallest
 *      snap interval ≥ `msPerFrame`. The list now extends to
 *      `10Y` so multi-decade climate datasets land on a sensible
 *      cadence instead of clamping to `1M`.
 *
 * Backward-compatible signature — the fourth arg accepts the
 * legacy `fps: number` form as well as the new options object,
 * so existing call sites don't need to change to get the snap-
 * list extension. New call sites pass an options object to
 * activate the period / frameCount paths.
 */
export function inferDisplayInterval(
  startTime: Date,
  endTime: Date,
  videoDuration: number,
  fpsOrOptions: number | DisplayIntervalOptions = 30,
): { intervalMs: number; showTime: boolean } {
  const opts: DisplayIntervalOptions = typeof fpsOrOptions === 'number'
    ? { fps: fpsOrOptions }
    : fpsOrOptions
  const fps = opts.fps ?? 30
  const totalMs = endTime.getTime() - startTime.getTime()

  // 1. Phase 3pg: exact frame count — divide the range.
  if (opts.frameCount && opts.frameCount > 1 && totalMs > 0) {
    const intervalMs = totalMs / (opts.frameCount - 1)
    return { intervalMs, showTime: intervalMs < ONE_DAY_MS }
  }

  // 2. Period field — convert ISO 8601 duration to ms.
  if (opts.period) {
    try {
      const parsed = parseISO8601Duration(opts.period)
      if (typeof parsed === 'object' && 'days' in parsed && parsed.days > 0) {
        const intervalMs = parsed.days * ONE_DAY_MS
        return { intervalMs, showTime: intervalMs < ONE_DAY_MS }
      }
    } catch {
      // Period was malformed — fall through to the legacy path.
    }
  }

  // 3. Fallback — smallest snap interval ≥ msPerFrame.
  const totalFrames = videoDuration * fps
  const msPerFrame = totalFrames > 0 ? totalMs / totalFrames : 0

  let chosen = SNAP_INTERVALS[SNAP_INTERVALS.length - 1]
  for (const snap of SNAP_INTERVALS) {
    if (snap.ms >= msPerFrame) {
      chosen = snap
      break
    }
  }

  return { intervalMs: chosen.ms, showTime: chosen.ms < ONE_DAY_MS }
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

/** Fixed-unit ISO-8601 duration subset (weeks/days/hours/minutes/
 *  seconds) — mirrors the server's `parseScheduleSeconds`.
 *  Calendar-fuzzy units (years, months) deliberately don't match:
 *  `parseISO8601Duration` approximates them, which is fine for
 *  frame-time math but wrong for liveness / cache-TTL decisions
 *  (PR #179 review). */
const FIXED_DURATION_RE =
  /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/

/**
 * Parse a `Dataset.period` ISO-8601 duration to milliseconds,
 * returning null (never throwing) for malformed, calendar-fuzzy
 * (P1M / P1Y), empty, or non-positive values — a single bad catalog
 * row must not break cache math (Phase Z4, PR #179 review).
 */
export function safePeriodMs(period: string | null | undefined): number | null {
  if (!period) return null
  const match = FIXED_DURATION_RE.exec(period)
  if (!match) return null
  const [, weeks, days, hours, minutes, seconds] = match
  if (!weeks && !days && !hours && !minutes && !seconds) return null
  // A bare trailing T ("P1DT") matches the regex but is invalid.
  if (period.includes('T') && !hours && !minutes && !seconds) return null
  const ms =
    Number(weeks ?? 0) * 7 * 86_400_000 +
    Number(days ?? 0) * 86_400_000 +
    Number(hours ?? 0) * 3_600_000 +
    Number(minutes ?? 0) * 60_000 +
    Number(seconds ?? 0) * 1_000
  // Overflowed components (1e999…) produce Infinity — reject, per
  // the "malformed returns null" contract (PR #179 review).
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

/**
 * Is this dataset's update cadence plausibly live? True when
 * `period` parses AND the data's trailing edge is within two
 * cadences of `now` (or `endTime` is absent — an updating row not
 * yet stamped). Historical time-series rows carry `period` too;
 * their stale `endTime` keeps them out (Phase Z4, PR #179 review).
 */
export function isLiveCadence(
  period: string | null | undefined,
  endTime: string | null | undefined,
  nowMs: number,
): boolean {
  const periodMs = safePeriodMs(period)
  if (periodMs === null) return false
  if (!endTime) return true
  const end = Date.parse(endTime)
  if (!Number.isFinite(end)) return false
  return nowMs - end <= 2 * periodMs
}
