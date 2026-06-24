/**
 * Cloudflare Pages Function — GET /api/v1/datasets/{id}/frames
 *
 * Phase 3pg/B — image-sequence frame enumeration. Returns the
 * publisher's per-frame metadata for a sequence dataset:
 *
 *   {
 *     "datasetId": "01HX...",
 *     "count": 240,
 *     "frames": [
 *       {
 *         "index": 0,
 *         "displayName": "ssta_20260516T120000Z.png",
 *         "originalFilename": "sst_2026-05-16T12:00:00Z.png",
 *         "timestamp": "2026-05-16T12:00:00.000Z",
 *         "contentDigest": "sha256:...",
 *         "url": "https://assets.example/uploads/.../frames/00000.png"
 *       },
 *       ...
 *     ],
 *     "cursor": "100"
 *   }
 *
 * Query parameters:
 *
 *   - `limit` (default 100, max 1000) — page size.
 *   - `cursor` (optional) — opaque page token; today it's the
 *     start-index of the next page as a base-10 string. Callers
 *     pass back the cursor from the prior response.
 *   - `from=ISO&to=ISO` — restrict to frames whose computed
 *     timestamp (`start_time + period × index`) falls inside the
 *     inclusive window. Requires the row to be a parseable time
 *     series.
 *   - `at=ISO` — return only the single closest frame to the
 *     given timestamp. Wins over `from` / `to` if both supplied.
 *
 * Visibility honors the same public filter as `/api/v1/datasets/{id}`:
 * restricted / federated / private rows return 404. Restricted-
 * row presigning is a follow-up — until then the only way to
 * surface frames for a non-public row is the publisher API the
 * portal already uses.
 */

import type { CatalogEnv } from '../../_lib/env'
import { getPublicDataset } from '../../_lib/catalog-store'
import { buildFrameRecallUrl, isR2PublicConfigured } from '../../_lib/r2-public-url'
import {
  findClosestFrameIndex,
  findFrameWindow,
  frameTimestamp,
  isFrameTimeSeries,
  loadFrameManifest,
  renderFrameDisplayName,
  type FrameManifestEntry,
} from '../../_lib/frames-manifest'

const CONTENT_TYPE = 'application/json; charset=utf-8'
const CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300'
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE },
  })
}

function parseLimit(raw: string | null): number | { error: string } {
  if (raw == null) return DEFAULT_LIMIT
  // Strict base-10 digits only — matches the `frameIndex` policy
  // on the sibling endpoint. `Number()` would silently accept
  // `1e2`, `10.0`, `+10`, leading whitespace, etc. Phase 3pg-
  // review/E — Copilot discussion_r3282216200.
  if (!/^\d+$/.test(raw)) {
    return { error: `limit must be a base-10 integer in [1, ${MAX_LIMIT}].` }
  }
  const n = parseInt(raw, 10)
  if (n < 1 || n > MAX_LIMIT) {
    return { error: `limit must be a base-10 integer in [1, ${MAX_LIMIT}].` }
  }
  return n
}

function parseCursor(raw: string | null): number | { error: string } {
  if (raw == null) return 0
  // Strict base-10 digits only. The cursor is the start-index of
  // the next page (a base-10 integer in `[0, frame_count]`), so
  // `cursor=` (empty), `cursor=3e2`, `cursor=0x10`, etc. should
  // all 400 rather than coerce to surprising offsets. Phase 3pg-
  // review/E — Copilot discussion_r3282216289.
  if (!/^\d+$/.test(raw)) {
    return { error: 'cursor must be a non-negative base-10 integer.' }
  }
  return parseInt(raw, 10)
}

function parseIsoTimestamp(raw: string, label: string): number | { error: string } {
  const ms = Date.parse(raw)
  if (Number.isNaN(ms)) return { error: `${label} is not a valid ISO 8601 timestamp.` }
  return ms
}

export const onRequestGet: PagesFunction<CatalogEnv, 'id'> = async context => {
  const idParam = context.params.id
  const id = Array.isArray(idParam) ? idParam[0] : idParam
  if (!id) return jsonError(400, 'invalid_request', 'Missing dataset id.')
  if (!context.env.CATALOG_DB) {
    return jsonError(503, 'binding_missing', 'CATALOG_DB binding is not configured.')
  }
  if (!context.env.CATALOG_R2) {
    return jsonError(503, 'binding_missing', 'CATALOG_R2 binding is not configured.')
  }

  const row = await getPublicDataset(context.env.CATALOG_DB, id)
  if (!row) return jsonError(404, 'not_found', `Dataset ${id} not found.`)
  if (
    row.frame_count == null ||
    row.frame_extension == null ||
    row.frame_source_filenames_ref == null
  ) {
    return jsonError(
      404,
      'not_a_frame_sequence',
      `Dataset ${id} has no image-sequence frames.`,
    )
  }

  const url = new URL(context.request.url)
  const limitOrErr = parseLimit(url.searchParams.get('limit'))
  if (typeof limitOrErr === 'object') return jsonError(400, 'invalid_limit', limitOrErr.error)
  const cursorOrErr = parseCursor(url.searchParams.get('cursor'))
  if (typeof cursorOrErr === 'object') return jsonError(400, 'invalid_cursor', cursorOrErr.error)

  // Time-window filters resolve to a `[fromIndex, toIndex]` pair.
  // `at` wins over `from`/`to`. Time filters require a parseable
  // `start_time` + `period`; the helpers return null otherwise.
  let windowFrom = 0
  let windowTo = row.frame_count - 1
  const at = url.searchParams.get('at')
  if (at) {
    const atMs = parseIsoTimestamp(at, 'at')
    if (typeof atMs === 'object') return jsonError(400, 'invalid_at', atMs.error)
    const closest = findClosestFrameIndex(row, atMs)
    if (closest == null) {
      return jsonError(
        400,
        'not_a_time_series',
        '?at requires a dataset with start_time + period set.',
      )
    }
    windowFrom = closest
    windowTo = closest
  } else if (url.searchParams.has('from') || url.searchParams.has('to')) {
    const fromRaw = url.searchParams.get('from')
    const toRaw = url.searchParams.get('to')
    if (!fromRaw || !toRaw) {
      return jsonError(
        400,
        'invalid_range',
        '?from and ?to must both be supplied when filtering by time.',
      )
    }
    const fromMs = parseIsoTimestamp(fromRaw, 'from')
    if (typeof fromMs === 'object') return jsonError(400, 'invalid_from', fromMs.error)
    const toMs = parseIsoTimestamp(toRaw, 'to')
    if (typeof toMs === 'object') return jsonError(400, 'invalid_to', toMs.error)
    if (toMs < fromMs) {
      return jsonError(400, 'invalid_range', '?to must not be earlier than ?from.')
    }
    // Pre-check time-series-ness explicitly so we can distinguish
    // it from "window is outside the series" — both look like a
    // `null` return from `findFrameWindow` but they mean very
    // different things. The former is a 400 (caller misconfigured
    // the query against a non-time-series row); the latter is a
    // 200 with an empty frames array (legitimate query that simply
    // didn't overlap the available data).
    if (!isFrameTimeSeries(row)) {
      return jsonError(
        400,
        'not_a_time_series',
        '?from / ?to require a dataset with start_time + period set.',
      )
    }
    const win = findFrameWindow(row, fromMs, toMs)
    if (win == null) {
      // Window is entirely outside `[start_time, start_time + period × frame_count)`.
      // Return an empty page so paginated callers can keep walking
      // without special-casing an error envelope.
      return new Response(
        JSON.stringify({ datasetId: id, count: row.frame_count, frames: [], cursor: null }),
        { status: 200, headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': CACHE_CONTROL } },
      )
    }
    windowFrom = win.fromIndex
    windowTo = win.toIndex
  }

  // Apply the cursor on top of the time window.
  const startIndex = Math.max(windowFrom, cursorOrErr)
  if (startIndex > windowTo) {
    return new Response(
      JSON.stringify({ datasetId: id, count: row.frame_count, frames: [], cursor: null }),
      { status: 200, headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': CACHE_CONTROL } },
    )
  }
  const endIndex = Math.min(windowTo, startIndex + limitOrErr - 1)

  // Recall needs an R2 public origin to resolve content-addressed
  // frame URLs; without one, surface the misconfig as a 503 the
  // operator fixes rather than emitting unresolvable URLs.
  if (!isR2PublicConfigured(context.env)) {
    return jsonError(
      503,
      'r2_unconfigured',
      'R2_PUBLIC_BASE / MOCK_R2 must be configured for the frame surface.',
    )
  }

  const manifestKey = row.frame_source_filenames_ref.startsWith('r2:')
    ? row.frame_source_filenames_ref.slice('r2:'.length)
    : row.frame_source_filenames_ref
  const manifest = await loadFrameManifest(context.env.CATALOG_R2, manifestKey)
  if (!manifest) {
    return jsonError(
      503,
      'frame_manifest_missing',
      `Frame manifest blob at ${manifestKey} could not be read.`,
    )
  }
  if (manifest.length !== row.frame_count) {
    return jsonError(
      503,
      'frame_manifest_inconsistent',
      `Frame manifest length ${manifest.length} does not match dataset frame_count ${row.frame_count}.`,
    )
  }

  const frames = renderFrameRange(context.env, id, row, manifest, startIndex, endIndex)
  if ('error' in frames) {
    return jsonError(
      500,
      'invalid_frame_metadata',
      `Dataset ${id} has a frame whose manifest digest or extension can't be resolved ` +
        `to a content-addressed URL (frame ${frames.error}). An operator should inspect the row.`,
    )
  }
  const nextCursor = endIndex < windowTo ? String(endIndex + 1) : null

  return new Response(
    JSON.stringify({
      datasetId: id,
      count: row.frame_count,
      frames,
      cursor: nextCursor,
    }),
    { status: 200, headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': CACHE_CONTROL } },
  )
}

interface RenderedFrame {
  index: number
  displayName: string
  originalFilename: string
  timestamp: string | null
  contentDigest: string
  url: string
}

/** Render a range of frames with **direct** content-addressed R2 URLs
 *  (resolved per-frame from the manifest digest). The list path skips
 *  the `/frames/{index}` redirect hop the dataset-level urlTemplate
 *  takes, so bulk recall goes straight to R2. Returns `{ error: index }`
 *  for the first frame whose digest/extension can't be resolved (a
 *  malformed row), which the caller turns into a 500. */
function renderFrameRange(
  env: CatalogEnv,
  datasetId: string,
  row: {
    slug: string
    start_time: string | null
    period: string | null
    frame_extension: string | null
  },
  manifest: FrameManifestEntry[],
  startIndex: number,
  endIndex: number,
): RenderedFrame[] | { error: number } {
  const ext = row.frame_extension!
  const out: RenderedFrame[] = []
  for (let i = startIndex; i <= endIndex; i++) {
    const url = buildFrameRecallUrl(env, datasetId, manifest[i].digest, ext)
    if (!url) return { error: i }
    out.push({
      index: i,
      displayName: renderFrameDisplayName(row, ext, i),
      originalFilename: manifest[i].filename,
      timestamp: frameTimestamp(row, i),
      contentDigest: manifest[i].digest,
      url,
    })
  }
  return out
}
