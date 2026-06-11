/**
 * Round-trip tests for the analytics layout registry: every event
 * type is encoded through the REAL `toDataPoint()` from
 * `functions/api/ingest.ts`, reassembled into the AE SQL row shape,
 * and decoded back via `decodeAeRow()`. A wrong field order, a
 * missing field, or a stale registry entry shows up as a fixture
 * mismatch here — before it can corrupt the R2 archive.
 *
 * The `FIXTURES` map is typed so that TypeScript requires exactly
 * one fixture per member of the `TelemetryEvent` union; adding a
 * new event type fails compilation of this file until a fixture
 * (and a registry entry) exists.
 */

import { describe, expect, it } from 'vitest'
import { toDataPoint } from '../../ingest'
import type { TelemetryEvent } from '../../../../src/types'
import {
  decodeAeRow,
  EVENT_LAYOUTS,
  type TelemetryEventType,
} from './analytics-layouts'

type EventFor<K extends TelemetryEventType> = Extract<TelemetryEvent, { event_type: K }>

const FIXTURES: { [K in TelemetryEventType]: EventFor<K> } = {
  session_start: {
    event_type: 'session_start',
    app_version: '0.5.0',
    platform: 'web',
    os: 'linux',
    locale: 'en-US',
    viewport_class: 'lg',
    aspect_class: 'wide',
    screen_class: '1080p',
    build_channel: 'public',
    vr_capable: 'none',
    schema_version: '1',
    resumed: true,
    client_offset_ms: 12,
  },
  session_end: {
    event_type: 'session_end',
    exit_reason: 'pagehide',
    duration_ms: 60_000,
    event_count: 42,
    client_offset_ms: 60_000,
  },
  layer_loaded: {
    event_type: 'layer_loaded',
    layer_id: 'INTERNAL_SOS_768',
    layer_source: 'hls',
    slot_index: '0',
    trigger: 'browse',
    load_ms: 1234,
    client_offset_ms: 5000,
  },
  layer_unloaded: {
    event_type: 'layer_unloaded',
    layer_id: 'INTERNAL_SOS_768',
    slot_index: '0',
    reason: 'replaced',
    dwell_ms: 90_000,
    client_offset_ms: 95_000,
  },
  feedback: {
    event_type: 'feedback',
    context: 'ai_response',
    kind: 'thumbs_up',
    status: 'ok',
    rating: 1,
    client_offset_ms: 100,
  },
  camera_settled: {
    event_type: 'camera_settled',
    slot_index: '0',
    projection: 'globe',
    center_lat: 39.739,
    center_lon: -104.99,
    zoom: 3.5,
    bearing: 0,
    pitch: 12,
    layer_id: '',
    client_offset_ms: 7000,
  },
  map_click: {
    event_type: 'map_click',
    slot_index: '0',
    hit_kind: 'marker',
    hit_id: 'marker-3',
    lat: 35.011,
    lon: 135.768,
    zoom: 5,
    client_offset_ms: 8000,
  },
  viewport_focus: {
    event_type: 'viewport_focus',
    slot_index: '1',
    layout: '2globes',
    client_offset_ms: 100,
  },
  layout_changed: {
    event_type: 'layout_changed',
    layout: '4globes',
    trigger: 'tools',
    client_offset_ms: 100,
  },
  playback_action: {
    event_type: 'playback_action',
    layer_id: 'INTERNAL_SOS_768',
    action: 'seek',
    playback_time_s: 12.5,
    playback_rate: 1,
    client_offset_ms: 100,
  },
  settings_changed: {
    event_type: 'settings_changed',
    key: 'labels',
    value_class: 'on',
    client_offset_ms: 100,
  },
  browse_opened: {
    event_type: 'browse_opened',
    source: 'tools',
    client_offset_ms: 100,
  },
  browse_filter: {
    event_type: 'browse_filter',
    category: 'Atmosphere',
    result_count_bucket: '11-50',
    client_offset_ms: 100,
  },
  catalog_view_mode_changed: {
    event_type: 'catalog_view_mode_changed',
    view_mode: 'graph',
    from: 'cards',
    result_count_bucket: '50+',
    client_offset_ms: 100,
  },
  tour_started: {
    event_type: 'tour_started',
    tour_id: 'tour-1',
    tour_title: 'Ocean Currents',
    source: 'browse',
    task_count: 9,
    client_offset_ms: 100,
  },
  tour_task_fired: {
    event_type: 'tour_task_fired',
    tour_id: 'tour-1',
    task_type: 'loadDataset',
    task_index: 3,
    task_dwell_ms: 4000,
    client_offset_ms: 100,
  },
  tour_paused: {
    event_type: 'tour_paused',
    tour_id: 'tour-1',
    reason: 'user',
    task_index: 3,
    client_offset_ms: 100,
  },
  tour_resumed: {
    event_type: 'tour_resumed',
    tour_id: 'tour-1',
    task_index: 3,
    pause_ms: 2500,
    client_offset_ms: 100,
  },
  tour_ended: {
    event_type: 'tour_ended',
    tour_id: 'tour-1',
    outcome: 'completed',
    task_index: 8,
    duration_ms: 300_000,
    client_offset_ms: 100,
  },
  tour_question_answered: {
    event_type: 'tour_question_answered',
    tour_id: 'tour-1',
    question_id: 'q2',
    task_index: 4,
    choice_count: 4,
    chosen_index: 2,
    correct_index: 2,
    was_correct: true,
    response_ms: 3200,
    client_offset_ms: 100,
  },
  vr_session_started: {
    event_type: 'vr_session_started',
    mode: 'ar',
    device_class: 'quest3',
    entry_load_ms: 1800,
    layer_id: 'INTERNAL_SOS_768',
    client_offset_ms: 100,
  },
  vr_session_ended: {
    event_type: 'vr_session_ended',
    mode: 'ar',
    exit_reason: 'user',
    duration_ms: 120_000,
    mean_fps: 71.5,
    layer_id: '',
    client_offset_ms: 100,
  },
  vr_placement: {
    event_type: 'vr_placement',
    layer_id: '',
    persisted: false,
    client_offset_ms: 100,
  },
  perf_sample: {
    event_type: 'perf_sample',
    surface: 'map',
    webgl_renderer_hash: 'a1b2c3d4',
    fps_median_10s: 58,
    frame_time_p95_ms: 22.4,
    jsheap_mb: 310,
    client_offset_ms: 100,
  },
  error: {
    event_type: 'error',
    category: 'hls',
    source: 'caught',
    code: '404',
    message_class: 'manifest fetch failed',
    count_in_batch: 2,
    client_offset_ms: 100,
  },
  migration_r2_hls: {
    event_type: 'migration_r2_hls',
    dataset_id: 'DS01HZX',
    legacy_id: 'INTERNAL_SOS_768',
    vimeo_id: '123456',
    r2_key: 'videos/DS01HZX/master.m3u8',
    source_bytes: 1_000_000,
    bundle_bytes: 2_000_000,
    encode_duration_ms: 90_000,
    upload_duration_ms: 20_000,
    duration_ms: 115_000,
    outcome: 'ok',
    client_offset_ms: 100,
  },
  migration_r2_assets: {
    event_type: 'migration_r2_assets',
    dataset_id: 'DS01HZX',
    legacy_id: '',
    asset_type: 'thumbnail',
    source_url: 'https://example.com/thumb.png',
    r2_key: 'datasets/DS01HZX/thumbnail.png',
    source_bytes: 50_000,
    duration_ms: 800,
    outcome: 'ok',
    client_offset_ms: 100,
  },
  migration_r2_tours: {
    event_type: 'migration_r2_tours',
    dataset_id: 'DS01HZX',
    legacy_id: '',
    source_url: 'https://example.com/tour.json',
    r2_key: 'tours/DS01HZX/tour.json',
    source_bytes: 80_000,
    siblings_relative: 5,
    siblings_external: 1,
    siblings_sos_cdn: 0,
    siblings_migrated: 5,
    duration_ms: 4000,
    outcome: 'ok',
    client_offset_ms: 100,
  },
  publisher_portal_loaded: {
    event_type: 'publisher_portal_loaded',
    route: 'datasets',
    client_offset_ms: 100,
  },
  publisher_action: {
    event_type: 'publisher_action',
    action: 'draft_saved',
    dataset_id: 'a1b2c3d4e5f6',
    client_offset_ms: 100,
  },
  dwell: {
    event_type: 'dwell',
    view_target: 'chat',
    duration_ms: 15_000,
    client_offset_ms: 100,
  },
  orbit_interaction: {
    event_type: 'orbit_interaction',
    interaction: 'message_sent',
    subtype: 'text',
    model: 'llama-3.1-70b',
    duration_ms: 0,
    input_tokens: 0,
    output_tokens: 0,
    client_offset_ms: 100,
  },
  orbit_turn: {
    event_type: 'orbit_turn',
    turn_role: 'assistant',
    reading_level: 'default',
    model: 'llama-3.1-70b',
    finish_reason: 'stop',
    turn_index: 2,
    duration_ms: 2400,
    input_tokens: 1500,
    output_tokens: 220,
    content_length: 900,
    turn_rounds: 2,
    client_offset_ms: 100,
  },
  orbit_tool_call: {
    event_type: 'orbit_tool_call',
    tool: 'load_dataset',
    result: 'ok',
    turn_index: 2,
    position_in_turn: 1,
    client_offset_ms: 100,
  },
  orbit_load_followed: {
    event_type: 'orbit_load_followed',
    dataset_id: 'INTERNAL_SOS_768',
    path: 'button_click',
    latency_ms: 1800,
    client_offset_ms: 100,
  },
  orbit_correction: {
    event_type: 'orbit_correction',
    signal: 'rephrased_same_turn',
    turn_index: 3,
    client_offset_ms: 100,
  },
  browse_search: {
    event_type: 'browse_search',
    query_hash: 'a1b2c3d4e5f6',
    result_count_bucket: '1-10',
    query_length: 14,
    client_offset_ms: 100,
  },
  catalog_graph_node_clicked: {
    event_type: 'catalog_graph_node_clicked',
    node_kind: 'facet-value',
    facet: 'Categories',
    value_hash: 'a1b2c3d4e5f6',
    client_offset_ms: 100,
  },
  catalog_timeline_brush_applied: {
    event_type: 'catalog_timeline_brush_applied',
    start_year: 1997,
    end_year: 2015,
    client_offset_ms: 100,
  },
  catalog_map_region_drawn: {
    event_type: 'catalog_map_region_drawn',
    north: 51.5,
    south: 35.011,
    east: 24.105,
    west: -10.667,
    client_offset_ms: 100,
  },
  vr_interaction: {
    event_type: 'vr_interaction',
    gesture: 'pinch',
    magnitude: 0.8,
    client_offset_ms: 100,
  },
  error_detail: {
    event_type: 'error_detail',
    category: 'uncaught',
    source: 'window_error',
    message_class: 'cannot read properties of undefined',
    stack_signature: 'a1b2c3d4e5f6',
    frames_json: '["fn1","fn2"]',
    count_in_batch: 1,
    client_offset_ms: 100,
  },
  publisher_validation_failed: {
    event_type: 'publisher_validation_failed',
    field: 'slug',
    code: 'slug_too_short',
    client_offset_ms: 100,
  },
}

const ENVELOPE = {
  sessionId: 'sess-0001',
  environment: 'production',
  country: 'US',
  internal: false,
}

/** Reassemble a `toDataPoint()` result into the AE SQL row shape
 * (`blob1`…`blob20` padded with '', `double1`…`double20` padded
 * with 0 — matching AE's read-side padding). */
function toAeSqlRow(event: TelemetryEvent): Record<string, unknown> {
  const dp = toDataPoint(
    event,
    ENVELOPE.sessionId,
    ENVELOPE.environment,
    ENVELOPE.country,
    ENVELOPE.internal,
  )
  const row: Record<string, unknown> = {
    timestamp: '2026-06-10 12:00:00',
    _sample_interval: 1,
    index1: dp.indexes?.[0] ?? '',
  }
  for (let i = 1; i <= 20; i++) {
    row[`blob${i}`] = dp.blobs?.[i - 1] ?? ''
    row[`double${i}`] = dp.doubles?.[i - 1] ?? 0
  }
  return row
}

describe('EVENT_LAYOUTS', () => {
  it('lists blob and double fields in alphabetical (wire) order', () => {
    for (const [eventType, layout] of Object.entries(EVENT_LAYOUTS)) {
      expect([...layout.blobs].sort(), `${eventType} blobs`).toEqual([...layout.blobs])
      expect([...layout.doubles].sort(), `${eventType} doubles`).toEqual([...layout.doubles])
    }
  })

  it('round-trips every event type through the real encoder', () => {
    for (const event of Object.values(FIXTURES) as TelemetryEvent[]) {
      const decoded = decodeAeRow(toAeSqlRow(event))
      expect(decoded.layout, event.event_type).toBe('named')
      expect(decoded.event_type).toBe(event.event_type)
      expect(decoded.environment).toBe(ENVELOPE.environment)
      expect(decoded.country).toBe(ENVELOPE.country)
      expect(decoded.internal).toBe(ENVELOPE.internal)
      expect(decoded.session_id).toBe(ENVELOPE.sessionId)
      expect(decoded.sample_interval).toBe(1)

      const { event_type: _ignored, ...expected } = event as unknown as Record<string, unknown>
      expect(decoded.fields, event.event_type).toEqual(expected)
    }
  })

  it('handles the optional-blob shift (session_start without resumed)', () => {
    const { resumed: _omitted, ...rest } = FIXTURES.session_start
    const event = rest as TelemetryEvent
    const decoded = decodeAeRow(toAeSqlRow(event))
    expect(decoded.layout).toBe('named')
    expect(decoded.fields.resumed).toBeUndefined()
    expect(decoded.fields.schema_version).toBe('1')
    expect(decoded.fields.vr_capable).toBe('none')
  })

  it('asserts the optional-blob detection precondition: the last blob field is never empty', () => {
    // The decoder detects an absent optional blob by checking the
    // LAST blob slot of the full layout. That only works while the
    // last field is a never-empty enum — for session_start, that's
    // `vr_capable`. If a field sorting after `vr_capable` is ever
    // added (or vr_capable becomes emptyable), the decoder needs a
    // new detection rule.
    const layout = EVENT_LAYOUTS.session_start
    expect(layout.blobs[layout.blobs.length - 1]).toBe('vr_capable')
    expect(FIXTURES.session_start.vr_capable).not.toBe('')
  })

  it('preserves rows of unknown event types positionally, including sentinel values', () => {
    const row = toAeSqlRow(FIXTURES.layer_loaded)
    row.blob1 = 'some_future_event'
    const decoded = decodeAeRow(row)
    expect(decoded.layout).toBe('unknown')
    expect(decoded.event_type).toBe('some_future_event')
    // blob5 was layer_id; double2 was load_ms — preserved by position.
    expect(decoded.fields.blob5).toBe('INTERNAL_SOS_768')
    expect(decoded.fields.double2).toBe(1234)
    // Every position survives — '' and 0 are legitimate sentinels in
    // the telemetry schema, so nothing is elided.
    expect(decoded.fields.blob20).toBe('')
    expect(decoded.fields.double20).toBe(0)
    expect(Object.keys(decoded.fields)).toHaveLength(16 + 20)
  })
})
