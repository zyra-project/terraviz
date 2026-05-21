/**
 * Frame-query resolution shared between Orbit (chat marker
 * parsing) and the dataset loader (clicking a frame button).
 *
 * Mirrors the server-side `frames-manifest.ts` helpers, scoped to
 * what the SPA actually needs: turn the LLM's
 * `<<LOAD_FRAME:DATASET_ID:query>>` payload into a concrete frame
 * index + display name + URL, against the `Dataset.frames`
 * envelope Phase 3pg/A added.
 */

import type { Dataset, DatasetFrames } from '../types'

/** Result of a successful frame-query resolution. `displayName`
 *  follows the same convention the server's `/frames` endpoint
 *  uses (`{slug}_{YYYYMMDDTHHMMSSZ}.{ext}` for time-series rows,
 *  `{slug}_frame_{NNNNN}.{ext}` for pure-sequence rows). */
export interface ResolvedFrame {
  index: number
  displayName: string
  url: string
  /** ISO 8601 UTC timestamp for the resolved frame. Null when the
   *  dataset is a pure-sequence row (no `period`). */
  timestamp: string | null
}

/**
 * Resolve a `<<LOAD_FRAME:...>>` query payload against a dataset's
 * frame envelope. Accepts:
 *   - `latest` / `last` → `frame_count - 1`
 *   - `first` → `0`
 *   - `index=N` → `N` (clamped to [0, count))
 *   - any ISO 8601 timestamp → closest frame by `start_time + period × i`
 *   - bare integer string → `N` (legacy shape)
 *
 * Returns null when the dataset has no frames envelope, the URL
 * template can't be expanded, or the query string doesn't match
 * any of the recognised forms.
 */
export function resolveFrameQuery(
  dataset: Dataset,
  query: string,
): ResolvedFrame | null {
  if (!dataset.frames) return null
  const frames = dataset.frames
  const trimmed = query.trim()
  const index = parseFrameQueryToIndex(trimmed, dataset)
  if (index == null) return null
  return buildResolvedFrame(dataset, frames, index)
}

function parseFrameQueryToIndex(query: string, dataset: Dataset): number | null {
  const count = dataset.frames!.count
  // A zero-or-negative count means the row is corrupt or mid-
  // ingest. `latest`/`first` against count=0 would otherwise
  // return -1 and emit a key like `frames/-0001.png` that R2
  // 404s. Fail closed so the chat parser drops the marker
  // rather than emitting a broken button. Phase 3pg-review/C —
  // Copilot discussion_r3277396427.
  if (!Number.isInteger(count) || count <= 0) return null
  const lower = query.toLowerCase()
  if (lower === 'latest' || lower === 'last') return count - 1
  if (lower === 'first') return 0
  const indexMatch = /^index\s*=\s*(\d+)$/i.exec(query)
  if (indexMatch) {
    const n = parseInt(indexMatch[1], 10)
    return clampToFrameRange(n, count)
  }
  // Bare integer — `<<LOAD_FRAME:ID:47>>` shape.
  if (/^\d+$/.test(query)) {
    return clampToFrameRange(parseInt(query, 10), count)
  }
  // ISO timestamp — needs `period` + `startTime` to map to an
  // index. Falls through when the dataset isn't a time series,
  // matching the server's `not_a_time_series` behaviour.
  const periodMs = parseIsoDurationMs(dataset.period)
  if (dataset.startTime && periodMs != null && periodMs > 0) {
    const startMs = Date.parse(dataset.startTime)
    const targetMs = Date.parse(query)
    if (!Number.isNaN(startMs) && !Number.isNaN(targetMs)) {
      return clampToFrameRange(Math.round((targetMs - startMs) / periodMs), count)
    }
  }
  return null
}

function clampToFrameRange(n: number, count: number): number | null {
  if (!Number.isInteger(n)) return null
  // Defence in depth: parseFrameQueryToIndex already refuses to
  // call us with count <= 0, but the helper might be reused
  // someday — return null rather than producing an invalid
  // index.
  if (count <= 0) return null
  if (n < 0) return 0
  if (n >= count) return count - 1
  return n
}

function buildResolvedFrame(
  dataset: Dataset,
  frames: DatasetFrames,
  index: number,
): ResolvedFrame | null {
  const padded = String(index).padStart(5, '0')
  const url = frames.urlTemplate.replace('{index}', padded)
  if (url === frames.urlTemplate) return null // template missing the token
  // Derive the file extension off the URL template so we don't
  // have to thread the dataset's `frame_extension` column through
  // the wire (it's baked into the template).
  const extMatch = /\.([a-z0-9]+)$/.exec(frames.urlTemplate)
  const ext = extMatch ? extMatch[1] : 'png'
  return {
    index,
    displayName: deriveDisplayName(dataset, ext, index),
    url,
    timestamp: deriveTimestamp(dataset, index),
  }
}

function deriveDisplayName(dataset: Dataset, ext: string, index: number): string {
  const slug = dataset.slug ?? dataset.id
  const ts = deriveTimestamp(dataset, index)
  if (ts) {
    return `${slug}_${isoBasicUtc(ts)}.${ext}`
  }
  const padded = String(index).padStart(5, '0')
  return `${slug}_frame_${padded}.${ext}`
}

function deriveTimestamp(dataset: Dataset, index: number): string | null {
  if (!dataset.startTime) return null
  const periodMs = parseIsoDurationMs(dataset.period)
  if (periodMs == null) return null
  const startMs = Date.parse(dataset.startTime)
  if (Number.isNaN(startMs)) return null
  return new Date(startMs + periodMs * index).toISOString()
}

function isoBasicUtc(iso: string): string {
  // 2026-05-16T12:00:00.000Z → 20260516T120000Z (no colons /
  // hyphens / milliseconds — filesystem-friendly).
  return iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

const MS_PER_GREGORIAN_YEAR = 365.2425 * 86_400_000
const MS_PER_GREGORIAN_MONTH = MS_PER_GREGORIAN_YEAR / 12
const DURATION_PATTERN =
  /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/

/** SPA-side mirror of the server's `parseIsoDuration`. Scoped to
 *  what frame-query resolution needs — return milliseconds or
 *  null. Bare `P` / `PT` fail-close rather than returning zero,
 *  matching the server policy. */
export function parseIsoDurationMs(input: string | undefined): number | null {
  if (!input) return null
  const match = DURATION_PATTERN.exec(input)
  if (!match) return null
  const [, y, mo, w, d, h, mi, s] = match
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
