/**
 * Helpers shared by the Phase 3pg/B `/frames` endpoints.
 *
 * Two responsibilities:
 *
 *   1. Read the canonical `source_filenames.json` blob written
 *      during the frames upload, parse it into a typed array of
 *      `{ index, filename, digest }` entries. The list endpoint
 *      uses this to surface the publisher's original on-disk
 *      filenames (`originalFilename` on the wire) and the per-
 *      frame digest (`contentDigest` on the wire) so tooling that
 *      needs the upload-time mapping can recover it without an
 *      extra round-trip per frame.
 *
 *   2. Render a per-frame display name. Two shapes per the plan:
 *      `{slug}_{YYYYMMDDTHHMMSSZ}.{ext}` for time-series rows
 *      (carry both `startTime` and `period`), and
 *      `{slug}_frame_{NNNNN}.{ext}` for pure-sequence rows. The
 *      server-rendered name keeps tooling, the SPA, the CLI, and
 *      Orbit's chat buttons on the same convention without each
 *      consumer re-implementing the rule.
 *
 * Visibility / authorization is the caller's concern — these
 * helpers operate on already-fetched row state and never decide
 * who's allowed to see the result.
 */

import type { DatasetRow } from './catalog-store'
import { parseIsoDuration } from './iso-duration'

export interface FrameManifestEntry {
  index: number
  filename: string
  digest: string
}

/** Parse the source-filenames JSON blob the publisher PUT and the
 *  transcode runner subsequently verified. Returns null when the
 *  blob is missing, unparseable, or doesn't match the canonical
 *  shape. Each entry's `index` must match its array position
 *  (Phase 3pf-review/H invariant) — anything else is a hand-edited
 *  blob and the manifest endpoint should fail-closed. */
export function parseFrameManifest(text: string): FrameManifestEntry[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const result: FrameManifestEntry[] = []
  for (let i = 0; i < parsed.length; i++) {
    const e = parsed[i]
    if (!e || typeof e !== 'object') return null
    const obj = e as Record<string, unknown>
    if (
      typeof obj.index !== 'number' ||
      typeof obj.filename !== 'string' ||
      typeof obj.digest !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(obj.digest)
    ) {
      return null
    }
    if (!Number.isInteger(obj.index) || obj.index !== i) return null
    result.push({ index: i, filename: obj.filename, digest: obj.digest })
  }
  return result
}

/**
 * Fetch + parse the source-filenames blob via the CATALOG_R2
 * binding. Returns null when the binding is missing, the object
 * doesn't exist, or the blob is malformed. The caller surfaces
 * that as a 503 — the row's `frame_source_filenames_ref` column
 * promised the blob would exist, so a missing one is a server-
 * side data-consistency problem (re-upload bug, partial
 * delete, etc.) not a client error.
 */
export async function loadFrameManifest(
  bucket: R2Bucket,
  key: string,
): Promise<FrameManifestEntry[] | null> {
  const obj = await bucket.get(key)
  if (!obj) return null
  const text = await obj.text()
  return parseFrameManifest(text)
}

/**
 * Render the server-canonical display name for a single frame.
 *
 *   - Time-series rows (both `start_time` and `period` set, and the
 *     `period` parses) format `startTime + period × index` in ISO
 *     8601 basic UTC (`YYYYMMDDTHHMMSSZ` — no colons or hyphens).
 *   - Anything else (no period, no start_time, malformed period)
 *     falls back to the pure-sequence `{slug}_frame_{NNNNN}.{ext}`
 *     shape.
 *
 * `ext` should be the dataset's `frame_extension` column value
 * (`png` / `jpg` / `webp`) — the same extension the per-frame R2
 * key uses, so the resulting display name matches what the file
 * would land as on disk.
 */
export function renderFrameDisplayName(
  row: Pick<DatasetRow, 'slug' | 'start_time' | 'period'>,
  ext: string,
  index: number,
): string {
  const padded = String(index).padStart(5, '0')
  if (row.start_time && row.period) {
    const periodMs = parseIsoDuration(row.period)
    if (periodMs != null) {
      const startMs = Date.parse(row.start_time)
      if (!Number.isNaN(startMs)) {
        const frameMs = startMs + periodMs * index
        const iso = isoBasicUtc(new Date(frameMs))
        return `${row.slug}_${iso}.${ext}`
      }
    }
  }
  return `${row.slug}_frame_${padded}.${ext}`
}

/** Format a Date as the ISO 8601 basic UTC form `YYYYMMDDTHHMMSSZ`.
 *  Used by `renderFrameDisplayName` for time-series rows so the
 *  filename round-trips through a filesystem without colons. */
function isoBasicUtc(d: Date): string {
  const iso = d.toISOString() // 2026-05-16T12:00:00.000Z
  // Strip the literal characters that aren't valid in many file
  // systems and drop the millisecond fraction: a frame index is
  // tied to the parent's `period`, which is at-best per-second on
  // the catalog's current data — sub-second precision in the
  // filename would be misleading.
  return iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

/**
 * Find the frame index whose timestamp is closest to `targetMs`.
 * Used by `?at=ISO` on the list endpoint and by the Orbit
 * load-frame marker (`<<LOAD_FRAME:DATASET_ID:ISO>>`).
 *
 * Returns null when the row isn't a parseable time-series — the
 * caller surfaces that as `?at requires a time-series dataset`,
 * since closest-frame addressing has no meaning without a period.
 */
export function findClosestFrameIndex(
  row: Pick<DatasetRow, 'start_time' | 'period' | 'frame_count'>,
  targetMs: number,
): number | null {
  if (!row.start_time || !row.period || row.frame_count == null) return null
  const periodMs = parseIsoDuration(row.period)
  if (periodMs == null || periodMs <= 0) return null
  const startMs = Date.parse(row.start_time)
  if (Number.isNaN(startMs)) return null
  const raw = (targetMs - startMs) / periodMs
  const rounded = Math.round(raw)
  if (rounded < 0) return 0
  if (rounded >= row.frame_count) return row.frame_count - 1
  return rounded
}

/**
 * Resolve a `[from, to]` frame-index window from an ISO time
 * window on a time-series row. Inclusive on both ends. Used by
 * `?from=ISO&to=ISO` on the list endpoint. Returns null on the
 * same conditions as `findClosestFrameIndex`.
 */
export function findFrameWindow(
  row: Pick<DatasetRow, 'start_time' | 'period' | 'frame_count'>,
  fromMs: number,
  toMs: number,
): { fromIndex: number; toIndex: number } | null {
  if (!row.start_time || !row.period || row.frame_count == null) return null
  const periodMs = parseIsoDuration(row.period)
  if (periodMs == null || periodMs <= 0) return null
  const startMs = Date.parse(row.start_time)
  if (Number.isNaN(startMs)) return null
  // Clamp to [0, frame_count) on both sides. `Math.ceil` on the
  // lower bound + `Math.floor` on the upper produces a strict
  // overlap rather than "any frame whose timestamp rounds into
  // the window" — a `?from=t&to=t` query then returns at most one
  // frame, which matches the closest-frame semantics of `?at`.
  const rawFrom = Math.ceil((fromMs - startMs) / periodMs)
  const rawTo = Math.floor((toMs - startMs) / periodMs)
  const fromIndex = Math.max(0, rawFrom)
  const toIndex = Math.min(row.frame_count - 1, rawTo)
  if (toIndex < fromIndex) return null
  return { fromIndex, toIndex }
}

/**
 * Compute the ISO 8601 UTC timestamp for a single frame in a time-
 * series row. Returns null when the row isn't a parseable time
 * series. Used by the list endpoint to surface `timestamp` on each
 * frame entry.
 */
export function frameTimestamp(
  row: Pick<DatasetRow, 'start_time' | 'period'>,
  index: number,
): string | null {
  if (!row.start_time || !row.period) return null
  const periodMs = parseIsoDuration(row.period)
  if (periodMs == null) return null
  const startMs = Date.parse(row.start_time)
  if (Number.isNaN(startMs)) return null
  return new Date(startMs + periodMs * index).toISOString()
}

/**
 * Quick predicate: does this row carry the metadata `?at` and
 * `?from` / `?to` filters need to do their index arithmetic?
 * Used by the list endpoint to distinguish "row isn't a time
 * series" (400 not_a_time_series) from "window is outside the
 * series" (200 with an empty frames array) — both of which look
 * like a `null` return from `findFrameWindow` / `findClosestFrameIndex`
 * but mean very different things to a consumer.
 */
export function isFrameTimeSeries(
  row: Pick<DatasetRow, 'start_time' | 'period' | 'frame_count'>,
): boolean {
  if (!row.start_time || !row.period || row.frame_count == null) return false
  const periodMs = parseIsoDuration(row.period)
  if (periodMs == null || periodMs <= 0) return false
  const startMs = Date.parse(row.start_time)
  return !Number.isNaN(startMs)
}
