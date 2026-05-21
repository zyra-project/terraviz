/**
 * Minimal ISO 8601 duration parser scoped to the shapes the catalog's
 * `period` column carries. Phase 3pg/B uses it to turn a sequence
 * dataset's `start_time` + `period` into per-frame timestamps so
 * the `/frames` endpoints' `?from` / `?to` / `?at` filters work.
 *
 * Catalog data covers durations from `PT1S` (per-second realtime
 * datasets) through `P1Y` (yearly composites). Calendar units
 * (`Y` / `M`) are accepted but evaluated against a fixed average
 * Gregorian year / month — the frames API uses the result to map
 * an index to a timestamp, where a few hours of drift across a
 * many-year sequence is acceptable. Sub-second precision isn't
 * relevant for any current source set.
 *
 * Returns `null` when the input doesn't parse, including the empty-
 * P case (`P`) or a string with no recognised components — neither
 * is a valid duration and silently returning zero would conflate
 * with a publisher's omitted `period` column.
 */

/** Average milliseconds per Gregorian year (365.2425 d × 86400 s × 1000 ms). */
const MS_PER_GREGORIAN_YEAR = 365.2425 * 86_400_000
/** Average milliseconds per Gregorian month (1/12 of the year). */
const MS_PER_GREGORIAN_MONTH = MS_PER_GREGORIAN_YEAR / 12

const DURATION_PATTERN =
  /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/

export function parseIsoDuration(input: string): number | null {
  if (typeof input !== 'string' || input.length < 2) return null
  const match = DURATION_PATTERN.exec(input)
  if (!match) return null
  const [, y, mo, w, d, h, mi, s] = match
  // Refuse "P" with no components at all — the regex accepts it
  // because every group is optional, but a bare "P" carries no
  // semantic meaning and should fail-closed rather than silently
  // returning zero.
  if (!y && !mo && !w && !d && !h && !mi && !s) return null
  let ms = 0
  if (y) ms += parseFloat(y) * MS_PER_GREGORIAN_YEAR
  if (mo) ms += parseFloat(mo) * MS_PER_GREGORIAN_MONTH
  if (w) ms += parseFloat(w) * 7 * 86_400_000
  if (d) ms += parseFloat(d) * 86_400_000
  if (h) ms += parseFloat(h) * 3_600_000
  if (mi) ms += parseFloat(mi) * 60_000
  if (s) ms += parseFloat(s) * 1000
  return ms
}
