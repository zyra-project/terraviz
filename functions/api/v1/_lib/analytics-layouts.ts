/**
 * Positional blob/double layouts for every telemetry event type —
 * the decode side of `toDataPoint()` in `functions/api/ingest.ts`.
 *
 * The ingest function encodes an event's own fields positionally:
 * blob1–4 are the server-stamped envelope (event_type, environment,
 * country, internal), then the event's string/boolean fields follow
 * in alphabetical order; doubles are the event's number fields in
 * alphabetical order. Human-readable copies of these layouts live
 * in `docs/ANALYTICS_QUERIES.md`; this module is the machine
 * counterpart, consumed by the analytics export job
 * (`analytics-export.ts`, Phase A of
 * `docs/ANALYTICS_STORAGE_AND_ADMIN_PLAN.md`) to decode AE rows
 * back into named fields before archiving them to R2.
 *
 * Drift protection is layered:
 *   - The `satisfies` clause below requires one entry per member of
 *     the `TelemetryEvent` union, with field names checked against
 *     that event's interface — adding/renaming an event or field
 *     without updating this table fails `tsc`.
 *   - `analytics-layouts.test.ts` round-trips a fixture for every
 *     event type through the real `toDataPoint()` encoder, so an
 *     ordering mistake here fails CI rather than corrupting the
 *     archive.
 */

import type { TelemetryEvent } from '../../../../src/types'

export type TelemetryEventType = TelemetryEvent['event_type']

type EventFor<K extends TelemetryEventType> = Extract<TelemetryEvent, { event_type: K }>

/** Keys of `E` that encode as blobs (strings and booleans — ingest
 * writes booleans as `'true'`/`'false'` strings). */
type BlobKeys<E> = {
  [K in keyof E]-?: NonNullable<E[K]> extends string | boolean
    ? K extends 'event_type'
      ? never
      : K
    : never
}[keyof E] &
  string

/** Keys of `E` that encode as doubles (numbers). */
type DoubleKeys<E> = {
  [K in keyof E]-?: NonNullable<E[K]> extends string | boolean ? never : K
}[keyof E] &
  string

export interface EventLayout {
  /** Event blob fields in wire order (alphabetical), i.e. blob5
   * onward. Includes `optionalBlob` (if any) at its sorted
   * position. */
  readonly blobs: readonly string[]
  /** Event double fields in wire order (alphabetical), i.e. double1
   * onward. */
  readonly doubles: readonly string[]
  /** Subset of `blobs` carrying `'true'`/`'false'` — decoded back
   * to booleans. */
  readonly booleans?: readonly string[]
  /** The single present-or-absent blob field (only
   * `session_start.resumed` today). When absent on the wire, every
   * later blob shifts up one position. Presence is detected by
   * whether the *last* blob slot of the full layout is populated —
   * valid only while the last field is a never-empty enum, which
   * the round-trip test asserts. */
  readonly optionalBlob?: string
}

export const EVENT_LAYOUTS = {
  // --- Tier A ---
  session_start: {
    blobs: [
      'app_version', 'aspect_class', 'build_channel', 'locale', 'os',
      'platform', 'resumed', 'schema_version', 'screen_class',
      'viewport_class', 'vr_capable',
    ],
    doubles: ['client_offset_ms'],
    booleans: ['resumed'],
    optionalBlob: 'resumed',
  },
  session_end: {
    blobs: ['exit_reason'],
    // `visible_ms` was added later and deliberately sorts last; rows
    // from clients predating it decode as 0 (AE pads unused doubles).
    doubles: ['client_offset_ms', 'duration_ms', 'event_count', 'visible_ms'],
  },
  layer_loaded: {
    blobs: ['layer_id', 'layer_source', 'slot_index', 'trigger'],
    doubles: ['client_offset_ms', 'load_ms'],
  },
  layer_unloaded: {
    blobs: ['layer_id', 'reason', 'slot_index'],
    doubles: ['client_offset_ms', 'dwell_ms'],
  },
  feedback: {
    blobs: ['context', 'kind', 'status'],
    doubles: ['client_offset_ms', 'rating'],
  },
  camera_settled: {
    blobs: ['layer_id', 'projection', 'slot_index'],
    doubles: ['bearing', 'center_lat', 'center_lon', 'client_offset_ms', 'pitch', 'zoom'],
  },
  map_click: {
    blobs: ['hit_id', 'hit_kind', 'slot_index'],
    doubles: ['client_offset_ms', 'lat', 'lon', 'zoom'],
  },
  viewport_focus: {
    blobs: ['layout', 'slot_index'],
    doubles: ['client_offset_ms'],
  },
  layout_changed: {
    blobs: ['layout', 'trigger'],
    doubles: ['client_offset_ms'],
  },
  playback_action: {
    blobs: ['action', 'layer_id'],
    doubles: ['client_offset_ms', 'playback_rate', 'playback_time_s'],
  },
  settings_changed: {
    blobs: ['key', 'value_class'],
    doubles: ['client_offset_ms'],
  },
  browse_opened: {
    blobs: ['source'],
    doubles: ['client_offset_ms'],
  },
  browse_filter: {
    blobs: ['category', 'result_count_bucket'],
    doubles: ['client_offset_ms'],
  },
  catalog_view_mode_changed: {
    blobs: ['from', 'result_count_bucket', 'view_mode'],
    doubles: ['client_offset_ms'],
  },
  tour_started: {
    blobs: ['source', 'tour_id', 'tour_title'],
    doubles: ['client_offset_ms', 'task_count'],
  },
  tour_task_fired: {
    blobs: ['task_type', 'tour_id'],
    doubles: ['client_offset_ms', 'task_dwell_ms', 'task_index'],
  },
  tour_paused: {
    blobs: ['reason', 'tour_id'],
    doubles: ['client_offset_ms', 'task_index'],
  },
  tour_resumed: {
    blobs: ['tour_id'],
    doubles: ['client_offset_ms', 'pause_ms', 'task_index'],
  },
  tour_ended: {
    blobs: ['outcome', 'tour_id', 'was_auto'],
    doubles: ['client_offset_ms', 'duration_ms', 'task_index'],
    booleans: ['was_auto'],
  },
  tour_question_answered: {
    blobs: ['question_id', 'tour_id', 'was_correct'],
    doubles: [
      'choice_count', 'chosen_index', 'client_offset_ms',
      'correct_index', 'response_ms', 'task_index',
    ],
    booleans: ['was_correct'],
  },
  vr_session_started: {
    blobs: ['device_class', 'layer_id', 'mode'],
    doubles: ['client_offset_ms', 'entry_load_ms'],
  },
  vr_session_ended: {
    blobs: ['exit_reason', 'layer_id', 'mode'],
    doubles: ['client_offset_ms', 'duration_ms', 'mean_fps'],
  },
  vr_placement: {
    blobs: ['layer_id', 'persisted'],
    doubles: ['client_offset_ms'],
    booleans: ['persisted'],
  },
  perf_sample: {
    blobs: ['surface', 'webgl_renderer_hash'],
    doubles: ['client_offset_ms', 'fps_median_10s', 'frame_time_p95_ms', 'jsheap_mb'],
  },
  error: {
    blobs: ['category', 'code', 'message_class', 'source'],
    doubles: ['client_offset_ms', 'count_in_batch'],
  },
  migration_r2_hls: {
    blobs: ['dataset_id', 'legacy_id', 'outcome', 'r2_key', 'vimeo_id'],
    doubles: [
      'bundle_bytes', 'client_offset_ms', 'duration_ms',
      'encode_duration_ms', 'source_bytes', 'upload_duration_ms',
    ],
  },
  migration_r2_assets: {
    blobs: ['asset_type', 'dataset_id', 'legacy_id', 'outcome', 'r2_key', 'source_url'],
    doubles: ['client_offset_ms', 'duration_ms', 'source_bytes'],
  },
  migration_r2_tours: {
    blobs: ['dataset_id', 'legacy_id', 'outcome', 'r2_key', 'source_url'],
    doubles: [
      'client_offset_ms', 'duration_ms', 'siblings_external',
      'siblings_migrated', 'siblings_relative', 'siblings_sos_cdn',
      'source_bytes',
    ],
  },
  publisher_portal_loaded: {
    blobs: ['route'],
    doubles: ['client_offset_ms'],
  },
  publisher_action: {
    blobs: ['action', 'dataset_id'],
    doubles: ['client_offset_ms'],
  },
  // --- Tier B ---
  dwell: {
    blobs: ['view_target'],
    doubles: ['client_offset_ms', 'duration_ms'],
  },
  orbit_interaction: {
    blobs: ['interaction', 'model', 'subtype'],
    doubles: ['client_offset_ms', 'duration_ms', 'input_tokens', 'output_tokens'],
  },
  orbit_turn: {
    blobs: ['finish_reason', 'model', 'reading_level', 'turn_role'],
    doubles: [
      'client_offset_ms', 'content_length', 'duration_ms',
      'input_tokens', 'output_tokens', 'turn_index', 'turn_rounds',
    ],
  },
  orbit_tool_call: {
    blobs: ['result', 'tool'],
    doubles: ['client_offset_ms', 'position_in_turn', 'turn_index'],
  },
  orbit_load_followed: {
    blobs: ['dataset_id', 'path'],
    doubles: ['client_offset_ms', 'latency_ms'],
  },
  orbit_correction: {
    blobs: ['signal'],
    doubles: ['client_offset_ms', 'turn_index'],
  },
  browse_search: {
    blobs: ['query_hash', 'result_count_bucket'],
    doubles: ['client_offset_ms', 'query_length'],
  },
  catalog_graph_node_clicked: {
    blobs: ['facet', 'node_kind', 'value_hash'],
    doubles: ['client_offset_ms'],
  },
  catalog_timeline_brush_applied: {
    blobs: [],
    doubles: ['client_offset_ms', 'end_year', 'start_year'],
  },
  catalog_map_region_drawn: {
    blobs: [],
    doubles: ['client_offset_ms', 'east', 'north', 'south', 'west'],
  },
  vr_interaction: {
    blobs: ['gesture'],
    doubles: ['client_offset_ms', 'magnitude'],
  },
  error_detail: {
    blobs: ['category', 'frames_json', 'message_class', 'source', 'stack_signature'],
    doubles: ['client_offset_ms', 'count_in_batch'],
  },
  publisher_validation_failed: {
    blobs: ['code', 'field'],
    doubles: ['client_offset_ms'],
  },
} as const satisfies {
  [K in TelemetryEventType]: {
    blobs: readonly BlobKeys<EventFor<K>>[]
    doubles: readonly DoubleKeys<EventFor<K>>[]
    booleans?: readonly BlobKeys<EventFor<K>>[]
    optionalBlob?: BlobKeys<EventFor<K>>
  }
}

/** Decoded AE row — the NDJSON line shape archived to R2. Envelope
 * fields are lifted to the top level; the event's own fields are
 * named under `fields`. `layout: 'unknown'` marks rows whose
 * event_type postdates this build of the exporter — their fields
 * are preserved positionally (`blob5`…, `double1`…) so the archive
 * never drops data; a later re-export of the day recovers names. */
export interface DecodedEventRow {
  timestamp: string
  event_type: string
  environment: string
  country: string
  internal: boolean
  session_id: string
  sample_interval: number
  layout: 'named' | 'unknown'
  fields: Record<string, string | number | boolean>
}

/** Number of envelope blobs preceding the event's own fields. */
const ENVELOPE_BLOBS = 4

function blobAt(row: Record<string, unknown>, position1: number): string {
  const v = row[`blob${position1}`]
  return typeof v === 'string' ? v : ''
}

function doubleAt(row: Record<string, unknown>, position1: number): number {
  const v = row[`double${position1}`]
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * Decode one AE SQL result row (a JSON object with `timestamp`,
 * `_sample_interval`, `index1`, `blob1`…`blob20`,
 * `double1`…`double20`) into named fields.
 */
export function decodeAeRow(row: Record<string, unknown>): DecodedEventRow {
  const eventType = blobAt(row, 1)
  const base: Omit<DecodedEventRow, 'layout' | 'fields'> = {
    timestamp: typeof row.timestamp === 'string' ? row.timestamp : '',
    event_type: eventType,
    environment: blobAt(row, 2),
    country: blobAt(row, 3),
    internal: blobAt(row, 4) === 'true',
    session_id: typeof row.index1 === 'string' ? row.index1 : '',
    sample_interval:
      typeof row._sample_interval === 'number' && row._sample_interval > 0
        ? row._sample_interval
        : 1,
  }

  const layout = (EVENT_LAYOUTS as Record<string, EventLayout>)[eventType]
  if (!layout) {
    // Unknown event type — preserve every position rather than drop.
    // Empty strings and zeros are kept too: both are legitimate
    // sentinel values in the telemetry schema, and at decode time we
    // can't tell a written sentinel from AE's read-side padding, so
    // the archive errs on keeping everything. A later re-export of
    // the day (with an updated registry) recovers the names.
    const fields: Record<string, string | number | boolean> = {}
    for (let i = ENVELOPE_BLOBS + 1; i <= 20; i++) {
      fields[`blob${i}`] = blobAt(row, i)
    }
    for (let i = 1; i <= 20; i++) {
      fields[`double${i}`] = doubleAt(row, i)
    }
    return { ...base, layout: 'unknown', fields }
  }

  // Resolve the optional-blob shift: if the last slot of the full
  // layout is unpopulated, the optional field was absent on the
  // wire and everything after its sorted position sits one slot
  // earlier.
  let blobNames: readonly string[] = layout.blobs
  if (layout.optionalBlob) {
    const lastSlot = ENVELOPE_BLOBS + layout.blobs.length
    if (blobAt(row, lastSlot) === '') {
      blobNames = layout.blobs.filter((name) => name !== layout.optionalBlob)
    }
  }

  const booleans = new Set(layout.booleans ?? [])
  const fields: Record<string, string | number | boolean> = {}
  blobNames.forEach((name, i) => {
    const raw = blobAt(row, ENVELOPE_BLOBS + 1 + i)
    fields[name] = booleans.has(name) ? raw === 'true' : raw
  })
  layout.doubles.forEach((name, i) => {
    fields[name] = doubleAt(row, 1 + i)
  })

  return { ...base, layout: 'named', fields }
}
