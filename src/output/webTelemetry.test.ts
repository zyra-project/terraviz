// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../analytics', () => ({
  TELEMETRY_BUILD_ENABLED: true,
  TELEMETRY_CONSOLE_MODE: false,
  BATCH_INTERVAL_MS: 5_000,
  createFetchTransport: vi.fn(() => ({
    endpoint: '/api/ingest',
    send: vi.fn(async () => ({ status: 204, ok: true, retryable: false, permanent: false })),
    sendBeacon: vi.fn(() => true),
  })),
  emit: vi.fn(),
  reportError: vi.fn(),
  setTransport: vi.fn(),
}))

import { createFetchTransport, emit, reportError, setTransport } from '../analytics'
import { WebDatasetError } from './webDataset'
import {
  WEB_OUTPUT_LAYER_LOADED_MAX_PER_MINUTE,
  WEB_OUTPUT_REPORT_WINDOW_MS,
  WEB_OUTPUT_SEND_DEADLINE_MS,
  deadlineTransport,
  startWebTelemetry,
  webOutputErrorCode,
  type WebTelemetryDeps,
} from './webTelemetry'
import type { MirroredDataset } from '../services/multiOutput/protocol'

const VIDEO: MirroredDataset = {
  id: 'ds-video',
  url: 'https://cdn.example/a.m3u8',
  kind: 'video',
  overlay: {},
  startTime: null,
  endTime: null,
}
const IMAGE: MirroredDataset = { ...VIDEO, id: 'ds-image', url: 'https://cdn.example/a_2048.jpg', kind: 'image' }

/** The `Error` handed to `reportError` on its `n`th call. */
function reported(n = 0): Error & { code?: string } {
  return vi.mocked(reportError).mock.calls[n][1] as Error & { code?: string }
}

/** Started with no transport, no GPC, and a clock the test moves. */
function started(over: WebTelemetryDeps = {}) {
  let now = 0
  const t = startWebTelemetry({ start: () => {}, globalPrivacyControl: () => false, nowMs: () => now, ...over })
  if (!t) throw new Error('telemetry did not start')
  return { t, at: (ms: number) => void (now = ms) }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('starting', () => {
  it('installs a deadline-bound transport and sends no session event', () => {
    // No session_start: it would put locale, OS and screen beside the
    // moment a visitor arrived.
    startWebTelemetry({ globalPrivacyControl: () => false })
    expect(createFetchTransport).toHaveBeenCalledTimes(1)
    const installed = vi.mocked(setTransport).mock.calls[0][0]!
    expect(installed.endpoint).toBe('/api/ingest')
    // Wrapped: the beacon sends nothing, whatever the inner one would do.
    const inner = vi.mocked(createFetchTransport).mock.results[0].value
    expect(installed.sendBeacon('s', [])).toBe(true)
    expect(inner.sendBeacon).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it('does not start at all when the browser has Global Privacy Control set', () => {
    const start = vi.fn()
    expect(startWebTelemetry({ start, globalPrivacyControl: () => true })).toBeNull()
    expect(start).not.toHaveBeenCalled()
  })

  it("reads Global Privacy Control from the browser when not told", () => {
    const nav = navigator as { globalPrivacyControl?: boolean }
    nav.globalPrivacyControl = true
    try {
      expect(startWebTelemetry({ start: () => {} })).toBeNull()
    } finally {
      delete nav.globalPrivacyControl
    }
    expect(startWebTelemetry({ start: () => {} })).not.toBeNull()
  })
})

describe('a dataset on the glass', () => {
  it('is a layer_loaded triggered by the output, under the id the node returned', () => {
    const { t } = started()
    t.datasetShown(VIDEO, 812.4)
    t.datasetShown(IMAGE, -3)
    expect(vi.mocked(emit).mock.calls.map(c => c[0])).toEqual([
      {
        event_type: 'layer_loaded',
        layer_id: 'ds-video',
        layer_source: 'hls',
        slot_index: '0',
        trigger: 'output',
        load_ms: 812,
      },
      // A clock step backwards cannot report a negative load.
      {
        event_type: 'layer_loaded',
        layer_id: 'ds-image',
        layer_source: 'image',
        slot_index: '0',
        trigger: 'output',
        load_ms: 0,
      },
    ])
  })

  it('is capped, because a script cycling the address sets the rate', () => {
    const { t } = started()
    for (let i = 0; i < WEB_OUTPUT_LAYER_LOADED_MAX_PER_MINUTE + 5; i++) t.datasetShown(VIDEO, 10)
    expect(emit).toHaveBeenCalledTimes(WEB_OUTPUT_LAYER_LOADED_MAX_PER_MINUTE)
  })
})

describe('the first minute only', () => {
  // Events later in a visit would show how long someone stood near the
  // globe, and copies reporting the same change together who stood there
  // together. The clock is page time.
  it('reports nothing once the minute after the page loaded is over', () => {
    const { t, at } = started()
    at(WEB_OUTPUT_REPORT_WINDOW_MS - 1)
    t.datasetShown(VIDEO, 10)
    t.streamError(new Error('networkError: fragLoadError'))
    at(WEB_OUTPUT_REPORT_WINDOW_MS)
    t.datasetShown(IMAGE, 10)
    t.datasetFailed(new WebDatasetError('http', 'HTTP 503'))
    t.streamError(new Error('mediaError: bufferStalledError'))

    expect(vi.mocked(emit).mock.calls.map(c => (c[0] as { layer_id: string }).layer_id)).toEqual(['ds-video'])
    expect(reportError).toHaveBeenCalledTimes(1)
  })

  it('reports nothing when telemetry is turned on after the first minute', () => {
    // A late `#telemetry=1` would otherwise open a minute on every copy
    // in range at the same instant, and link everyone standing there.
    const t = startWebTelemetry({
      start: () => {},
      globalPrivacyControl: () => false,
      nowMs: () => WEB_OUTPUT_REPORT_WINDOW_MS + 30_000,
    })!
    t.datasetShown(VIDEO, 10)
    t.streamError(new Error('networkError: fragLoadError'))
    expect(emit).not.toHaveBeenCalled()
    expect(reportError).not.toHaveBeenCalled()
  })
})

describe('sending stops at the deadline', () => {
  const inner = () => ({
    endpoint: '/api/ingest',
    send: vi.fn(async () => ({ status: 204, ok: true, retryable: false, permanent: false })),
    sendBeacon: vi.fn(() => true),
  })

  it('sends before the deadline and drops for good after it, so a retry cannot land late', async () => {
    let now = 0
    const real = inner()
    const t = deadlineTransport(real, WEB_OUTPUT_SEND_DEADLINE_MS, () => now)
    now = WEB_OUTPUT_SEND_DEADLINE_MS - 1
    expect(await t.send('s', [])).toMatchObject({ ok: true })
    now = WEB_OUTPUT_SEND_DEADLINE_MS
    // `permanent` is what makes the emitter stop and drop its queue.
    expect(await t.send('s', [])).toEqual({ status: null, ok: false, retryable: false, permanent: true })
    expect(real.send).toHaveBeenCalledTimes(1)
  })

  it('never sends by beacon, which would date the visitor leaving', () => {
    const real = inner()
    const t = deadlineTransport(real, WEB_OUTPUT_SEND_DEADLINE_MS, () => 0)
    expect(t.sendBeacon('s', [])).toBe(true)
    expect(real.sendBeacon).not.toHaveBeenCalled()
  })

  it('leaves a batch room to go after the last event of the window', () => {
    expect(WEB_OUTPUT_SEND_DEADLINE_MS).toBeGreaterThan(WEB_OUTPUT_REPORT_WINDOW_MS + 5_000)
  })
})

describe('errors', () => {
  it("reports a dataset failure by the node's own reason, with a fixed message and no stack", () => {
    const { t } = started()
    // The message names the dataset the address asked for, and the
    // address is text someone typed. It must not reach the wire.
    t.datasetFailed(new WebDatasetError('not_found', 'no dataset my-secret-globe-name'))
    expect(vi.mocked(reportError).mock.calls[0][0]).toBe('output')
    expect(reported().code).toBe('not_found')
    expect(reported().message).toBe('output not_found')
    expect(reported().stack).toBe('')
    expect(JSON.stringify(vi.mocked(reportError).mock.calls)).not.toContain('my-secret-globe-name')
  })

  it("reports a stream's fatal error under code 'stream', with hls.js's own error names and no stack", () => {
    const { t } = started()
    t.streamError(new Error('networkError: fragLoadError'))
    expect(vi.mocked(reportError).mock.calls[0][0]).toBe('output')
    expect(reported().code).toBe('stream')
    expect(reported().message).toBe('networkError: fragLoadError')
    expect(reported().stack).toBe('')
  })

  it('reports through the real emitter: nothing under Off, and no error_detail even under Research', async () => {
    // A stored setting for this site governs a globe's page too. And with
    // no stack, a Research-tier browser gets the `error` row alone, not
    // the `error_detail` the docs do not list for a globe.
    vi.resetModules()
    vi.doUnmock('../analytics')
    try {
      const analytics = await import('../analytics')
      const { startWebTelemetry: start } = await import('./webTelemetry')
      const t = start({ start: () => {}, globalPrivacyControl: () => false })!

      localStorage.setItem('sos-telemetry-config', JSON.stringify({ tier: 'off' }))
      t.datasetShown(VIDEO, 10)
      t.streamError(new Error('networkError: fragLoadError'))
      expect(analytics.size()).toBe(0)

      localStorage.setItem('sos-telemetry-config', JSON.stringify({ tier: 'research' }))
      t.datasetShown(VIDEO, 10)
      t.streamError(new Error('mediaError: bufferStalledError'))
      const types = analytics.flush().map(e => e.event_type)
      expect(types.sort()).toEqual(['error', 'layer_loaded'])
    } finally {
      localStorage.removeItem('sos-telemetry-config')
      vi.resetModules()
    }
  })

  it('classifies a failure into a bounded code', () => {
    expect(webOutputErrorCode(new WebDatasetError('http', 'HTTP 503'))).toBe('http')
    expect(webOutputErrorCode(new WebDatasetError('not_playable', 'a tour'))).toBe('not_playable')
    expect(webOutputErrorCode(new WebDatasetError('network', 'no answer'))).toBe('network')
    // A bug's `TypeError` is not the network failing; `webDataset` says
    // `network` itself where the fetch fails.
    expect(webOutputErrorCode(new TypeError('x is not a function'))).toBe('media')
    expect(webOutputErrorCode(new Error('no address for x would load'))).toBe('media')
    expect(webOutputErrorCode('something else')).toBe('media')
  })
})
