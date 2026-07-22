/**
 * Schedule math for Zyra workflows (Phase Z1,
 * `docs/ZYRA_INTEGRATION_PLAN.md` §Data model).
 *
 * `workflows.schedule` is an ISO-8601 duration — the same
 * vocabulary as `datasets.period` — rather than cron. The portal
 * offers period presets; this module parses the stored string and
 * computes `next_run_at`. Calendar-fuzzy units (years, months) are
 * rejected: a workflow cadence needs unambiguous arithmetic, and
 * "every month" is better expressed as P30D by the caller than
 * guessed at here.
 */

import {
  MAX_SCHEDULE_SECONDS,
  MIN_SCHEDULE_SECONDS,
} from '../../../../src/types/zyra-workflow-constants'

const DURATION_RE =
  /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/

/**
 * Parse an ISO-8601 duration (weeks/days/hours/minutes/seconds
 * subset) to seconds. Returns null for anything unparsable, empty
 * (`P`, `PT`), or using calendar units.
 */
export function parseScheduleSeconds(schedule: string): number | null {
  const match = DURATION_RE.exec(schedule)
  if (!match) return null
  const [, weeks, days, hours, minutes, seconds] = match
  if (!weeks && !days && !hours && !minutes && !seconds) return null
  // "P1DT" matches the regex with an empty time section, but a
  // bare T is not valid ISO-8601 (PR #176 Copilot review).
  if (schedule.includes('T') && !hours && !minutes && !seconds) return null
  return (
    Number(weeks ?? 0) * 7 * 86_400 +
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0)
  )
}

/** Is this a storable workflow schedule? (Parseable and within the
 *  tick-floor / sanity-ceiling bounds.) */
export function isValidSchedule(schedule: string): boolean {
  const seconds = parseScheduleSeconds(schedule)
  return (
    seconds !== null &&
    seconds >= MIN_SCHEDULE_SECONDS &&
    seconds <= MAX_SCHEDULE_SECONDS
  )
}

/**
 * The next due time from now, ISO-8601. Used on save (enable /
 * schedule change), where "now" is the only anchor there is.
 */
export function computeNextRunAt(schedule: string, now: Date = new Date()): string | null {
  const seconds = parseScheduleSeconds(schedule)
  if (seconds === null) return null
  return new Date(now.getTime() + seconds * 1000).toISOString()
}

/**
 * The next due time when a scheduled run is queued, anchored to the
 * stored due time rather than the wall clock. Bumping at queue time,
 * not completion, is what stops the next 15-minute tick from
 * re-dispatching a workflow whose run is still going — but `now +
 * period` would also add every dispatch delay (cron tick
 * granularity, GHA schedule jitter, which is hours-scale under
 * load) to the phase permanently, ratcheting a daily run around the
 * clock. Advancing `due` by whole periods keeps the phase stable and
 * per-run jitter per-run. A far-behind workflow (disabled scheduler,
 * long outage) skips straight past the missed slots — always
 * strictly future, never a catch-up burst.
 */
export function advanceNextRunAt(
  schedule: string,
  due: string | null,
  now: Date = new Date(),
): string | null {
  const seconds = parseScheduleSeconds(schedule)
  // <= 0 guards zero-length durations (`PT0S` parses to 0): a zero
  // period makes the catch-up division blow up to Infinity and
  // toISOString() throw. Unreachable via /validate (15-min floor) —
  // this is for legacy/corrupted rows (PR #303 Copilot review).
  if (seconds === null || seconds <= 0) return null
  const dueMs = due === null ? NaN : Date.parse(due)
  // No parseable anchor (legacy row, manual enable path) — fall
  // back to wall-clock, which then becomes the anchor.
  if (!Number.isFinite(dueMs)) return computeNextRunAt(schedule, now)
  const periodMs = seconds * 1000
  const periodsBehind = Math.floor((now.getTime() - dueMs) / periodMs)
  const advance = Math.max(1, periodsBehind + 1)
  return new Date(dueMs + advance * periodMs).toISOString()
}
