// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for `cli/lib/migration-telemetry.ts` (Phase 3 commit C helper).
 *
 * Coverage:
 *   - Single-event POST to `<serverUrl>/api/ingest`
 *   - Body shape — `{ session_id, events: [event] }`
 *   - Session id reuse across emits
 *   - Origin header stamped (Phase 2's commit-2/M fix carried
 *     forward)
 *   - Origin omitted when serverUrl is malformed
 *   - Emit failures (transport error / non-2xx) call onWarn but
 *     do not throw
 *   - serverUrl trailing-slash trim
 *   - Generic event-type — accepts arbitrary event_type strings
 */

import { describe, expect, it, vi } from 'vitest'
import { makeMigrationTelemetryEmitter } from './migration-telemetry'

const SAMPLE = {
  event_type: 'migration_r2_hls',
  dataset_id: 'DS00001AAAAAAAAAAAAAAAAAAAAA',
  legacy_id: 'INTERNAL_SOS_768',
  vimeo_id: '1107911993',
  r2_key: 'videos/DS00001AAAAAAAAAAAAAAAAAAAAA/master.m3u8',
  source_bytes: 1024,
  bundle_bytes: 8192,
  encode_duration_ms: 30_000,
  upload_duration_ms: 2_000,
  duration_ms: 35_000,
  outcome: 'ok',
}

describe('makeMigrationTelemetryEmitter', () => {
  it('POSTs the event to /api/ingest with session_id in the batch', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      captured = { url, init }
      return new Response('{}', { status: 200 })
    })
    const emitter = makeMigrationTelemetryEmitter({
      serverUrl: 'https://terraviz.zyra-project.org',
      sessionId: 'fixed-session',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await emitter.emit(SAMPLE)
    expect(captured!.url).toBe('https://terraviz.zyra-project.org/api/ingest')
    expect(captured!.init.method).toBe('POST')
    const body = JSON.parse(captured!.init.body as string)
    expect(body).toEqual({ session_id: 'fixed-session', events: [SAMPLE] })
  })

  it('reuses the session id across emits', async () => {
    const sessions: string[] = []
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { session_id: string }
      sessions.push(body.session_id)
      return new Response('{}', { status: 200 })
    })
    const emitter = makeMigrationTelemetryEmitter({
      serverUrl: 'https://x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await emitter.emit(SAMPLE)
    await emitter.emit({ ...SAMPLE, dataset_id: 'DS2' })
    expect(sessions[0]).toBe(sessions[1])
    expect(sessions[0]).toBe(emitter.sessionId)
  })

  it('stamps an Origin header matching the serverUrl (Phase 2/M)', async () => {
    let captured: RequestInit | null = null
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      captured = init
      return new Response('{}', { status: 200 })
    })
    const emitter = makeMigrationTelemetryEmitter({
      serverUrl: 'https://terraviz.zyra-project.org',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await emitter.emit(SAMPLE)
    const headers = (captured!.headers as Record<string, string>) ?? {}
    expect(headers.Origin).toBe('https://terraviz.zyra-project.org')
  })

  it('omits the Origin header when serverUrl is malformed', async () => {
    let captured: RequestInit | null = null
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      captured = init
      return new Response('{}', { status: 200 })
    })
    const emitter = makeMigrationTelemetryEmitter({
      serverUrl: 'not-a-url',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await emitter.emit(SAMPLE)
    const headers = (captured!.headers as Record<string, string>) ?? {}
    expect(headers.Origin).toBeUndefined()
  })

  it('trims trailing slashes from the serverUrl', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const emitter = makeMigrationTelemetryEmitter({
      serverUrl: 'https://x.test/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await emitter.emit(SAMPLE)
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('https://x.test/api/ingest')
  })

  it('warns but does not throw when the transport rejects', async () => {
    const warnings: string[] = []
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('connect ECONNREFUSED')
    })
    const emitter = makeMigrationTelemetryEmitter({
      serverUrl: 'https://x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onWarn: msg => warnings.push(msg),
    })
    await expect(emitter.emit(SAMPLE)).resolves.toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(SAMPLE.dataset_id)
    expect(warnings[0]).toContain('unreachable')
  })

  it('warns but does not throw on non-2xx', async () => {
    const warnings: string[] = []
    const fetchImpl = vi.fn(async () => new Response('invalid body', { status: 400 }))
    const emitter = makeMigrationTelemetryEmitter({
      serverUrl: 'https://x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onWarn: msg => warnings.push(msg),
    })
    await emitter.emit(SAMPLE)
    expect(warnings[0]).toContain('400')
  })

  it('fresh emitters get fresh session ids', () => {
    const a = makeMigrationTelemetryEmitter({ serverUrl: 'https://x' })
    const b = makeMigrationTelemetryEmitter({ serverUrl: 'https://x' })
    expect(a.sessionId).not.toBe(b.sessionId)
  })

  it('accepts arbitrary event_type strings (event-type-agnostic)', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const emitter = makeMigrationTelemetryEmitter({
      serverUrl: 'https://x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(
      emitter.emit({ event_type: 'something_new', foo: 'bar', count: 42 }),
    ).resolves.toBeUndefined()
  })
})
