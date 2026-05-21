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
import { buildFramesUrlTemplate, isR2PublicConfigured } from '../../_lib/r2-public-url'
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

  // Two distinct failure modes for `buildFramesUrlTemplate`:
  //   - deployment misconfig (no `R2_PUBLIC_BASE`/`MOCK_R2`) — a
  //     503 the operator needs to fix.
  //   - bad row data (malformed `frame_source_filenames_ref` or
  //     extension) — a 500 the publisher's row landed in a state
  //     `clearTranscoding` shouldn't produce.
  // Pre-checking the env lets the post-fact `null` surface as the
  // correct row-data error rather than misleading the operator
  // into chasing an env config that's already fine. Phase 3pg-
  // review/B — Copilot discussion_r3277221658.
  if (!isR2PublicConfigured(context.env)) {
    return jsonError(
      503,
      'r2_unconfigured',
      'R2_PUBLIC_BASE / MOCK_R2 must be configured for the frame surface.',
    )
  }
  const urlTemplate = buildFramesUrlTemplate(
    context.env,
    row.frame_source_filenames_ref,
    row.frame_extension,
  )
  if (!urlTemplate) {
    return jsonError(
      500,
      'invalid_frame_metadata',
      `Dataset ${id}'s frame_source_filenames_ref or frame_extension is malformed; ` +
        'frame URLs cannot be built. An operator should inspect the row.',
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

  const frames = renderFrameRange(
    row,
    manifest,
    urlTemplate,
    startIndex,
    endIndex,
  )
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

function renderFrameRange(
  row: {
    slug: string
    start_time: string | null
    period: string | null
    frame_extension: string | null
  },
  manifest: FrameManifestEntry[],
  urlTemplate: string,
  startIndex: number,
  endIndex: number,
): Array<{
  index: number
  displayName: string
  originalFilename: string
  timestamp: string | null
  contentDigest: string
  url: string
}> {
  const ext = row.frame_extension!
  const out: ReturnType<typeof renderFrameRange> = []
  for (let i = startIndex; i <= endIndex; i++) {
    const padded = String(i).padStart(5, '0')
    out.push({
      index: i,
      displayName: renderFrameDisplayName(row, ext, i),
      originalFilename: manifest[i].filename,
      timestamp: frameTimestamp(row, i),
      contentDigest: manifest[i].digest,
      url: urlTemplate.replace('{index}', padded),
    })
  }
  return out
}
