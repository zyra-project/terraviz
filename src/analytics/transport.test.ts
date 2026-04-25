import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { LayerLoadedEvent } from '../types'
import {
  createFetchTransport,
  classifyResponse,
  clearPersistedQueue,
  hydrateQueue,
  persistQueue,
  PERSISTED_QUEUE_KEY,
  __setPersistOverrideForTests,
} from './transport'

// --- Fixtures ---

function layerLoaded(id = 'A'): LayerLoadedEvent {
  return {
    event_type: 'layer_loaded',
    layer_id: id,
    layer_source: 'network',
    slot_index: '0',
    trigger: 'browse',
    load_ms: 100,
  }
}

// --- classifyResponse ---

describe('transport.classifyResponse', () => {
  it('marks 204 as ok', () => {
    expect(classifyResponse(204)).toEqual({
      status: 204, ok: true, retryable: false, permanent: false,
    })
  })

  it('marks 410 as permanent cooldown', () => {
    const r = classifyResponse(410)
    expect(r.ok).toBe(false)
    expect(r.permanent).toBe(true)
    expect(r.retryable).toBe(false)
  })

  it.each([429, 500, 502, 503, 504])('marks %i as retryable', (status) => {
    const r = classifyResponse(status)
    expect(r.ok).toBe(false)
    expect(r.retryable).toBe(true)
    expect(r.permanent).toBe(false)
  })

  it.each([400, 403, 404, 413])('marks %i as drop-only (no retry, no cooldown)', (status) => {
    const r = classifyResponse(status)
    expect(r.ok).toBe(false)
    expect(r.retryable).toBe(false)
    expect(r.permanent).toBe(false)
  })
})

// --- createFetchTransport.send ---

describe('transport.send — status mapping', () => {
  it('reports ok on 204 and POSTs the expected payload', async () => {
    const fetchImpl: typeof globalThis.fetch = vi.fn(
      async () => new Response(null, { status: 204 }),
    )
    const transport = createFetchTransport({ fetchImpl })

    const result = await transport.send('sess-1', [layerLoaded('A'), layerLoaded('B')])

    expect(result.ok).toBe(true)
    const mock = vi.mocked(fetchImpl)
    expect(mock).toHaveBeenCalledTimes(1)
    const call = mock.mock.calls[0]
    const init = call[1]
    expect(init?.method).toBe('POST')
    const body = JSON.parse(init?.body as string) as { session_id: string; events: unknown[] }
    expect(body.session_id).toBe('sess-1')
    expect(body.events).toHaveLength(2)
  })

  it('reports permanent on 410', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 410 }))
    const transport = createFetchTransport({ fetchImpl })
    const result = await transport.send('s', [layerLoaded()])
    expect(result.permanent).toBe(true)
  })

  it('reports retryable on 503', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }))
    const transport = createFetchTransport({ fetchImpl })
    const result = await transport.send('s', [layerLoaded()])
    expect(result.retryable).toBe(true)
  })

  it('reports retryable on network failure', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNRESET') })
    const transport = createFetchTransport({ fetchImpl })
    const result = await transport.send('s', [layerLoaded()])
    expect(result.status).toBeNull()
    expect(result.retryable).toBe(true)
    expect(result.permanent).toBe(false)
  })

  it('short-circuits on empty batches without calling fetch', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
    const transport = createFetchTransport({ fetchImpl })
    const result = await transport.send('s', [])
    expect(result.ok).toBe(true)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

// --- sendBeacon ---

describe('transport.sendBeacon', () => {
  it('delegates to the beacon impl with a JSON blob', () => {
    const beaconImpl: (url: string, body: BodyInit) => boolean = vi.fn(() => true)
    const transport = createFetchTransport({ beaconImpl, endpoint: '/foo/bar' })

    const accepted = transport.sendBeacon('sess-X', [layerLoaded()])
    expect(accepted).toBe(true)
    const mock = vi.mocked(beaconImpl)
    expect(mock).toHaveBeenCalledTimes(1)
    const [url, body] = mock.mock.calls[0]
    expect(url).toBe('/foo/bar')
    expect(body).toBeInstanceOf(Blob)
  })

  it('returns false when the beacon is rejected by the browser', () => {
    const beaconImpl = vi.fn(() => false)
    const transport = createFetchTransport({ beaconImpl })
    expect(transport.sendBeacon('s', [layerLoaded()])).toBe(false)
  })

  it('returns true for empty batches without calling the beacon', () => {
    const beaconImpl = vi.fn(() => true)
    const transport = createFetchTransport({ beaconImpl })
    expect(transport.sendBeacon('s', [])).toBe(true)
    expect(beaconImpl).not.toHaveBeenCalled()
  })
})

// --- Persistence ---

describe('transport — offline queue persistence (Tauri only)', () => {
  beforeEach(() => {
    localStorage.clear()
    __setPersistOverrideForTests(true)
  })

  afterEach(() => {
    __setPersistOverrideForTests(null)
  })

  it('round-trips a non-empty queue through localStorage', () => {
    persistQueue([layerLoaded('A'), layerLoaded('B')])
    expect(localStorage.getItem(PERSISTED_QUEUE_KEY)).not.toBeNull()

    const hydrated = hydrateQueue()
    expect(hydrated).toHaveLength(2)
    expect(hydrated[0].event_type).toBe('layer_loaded')
    // hydrate consumes the persisted copy
    expect(localStorage.getItem(PERSISTED_QUEUE_KEY)).toBeNull()
  })

  it('removes the key when persisting an empty queue', () => {
    persistQueue([layerLoaded('A')])
    expect(localStorage.getItem(PERSISTED_QUEUE_KEY)).not.toBeNull()
    persistQueue([])
    expect(localStorage.getItem(PERSISTED_QUEUE_KEY)).toBeNull()
  })

  it('hydrate returns [] and clears on malformed JSON', () => {
    localStorage.setItem(PERSISTED_QUEUE_KEY, '{not json')
    expect(hydrateQueue()).toEqual([])
    expect(localStorage.getItem(PERSISTED_QUEUE_KEY)).toBeNull()
  })

  it('hydrate filters out entries that are missing event_type', () => {
    localStorage.setItem(
      PERSISTED_QUEUE_KEY,
      JSON.stringify([layerLoaded('A'), { junk: true }, { event_type: 'feedback' }]),
    )
    const hydrated = hydrateQueue()
    expect(hydrated.map((e) => e.event_type)).toEqual(['layer_loaded', 'feedback'])
  })

  it('clearPersistedQueue removes the key unconditionally', () => {
    persistQueue([layerLoaded('A')])
    clearPersistedQueue()
    expect(localStorage.getItem(PERSISTED_QUEUE_KEY)).toBeNull()
  })

  it('clips persisted queues beyond the MAX_PERSISTED_EVENTS cap', () => {
    const many = Array.from({ length: 600 }, (_, i) => layerLoaded(`ID_${i}`))
    persistQueue(many)
    const hydrated = hydrateQueue()
    expect(hydrated.length).toBeLessThanOrEqual(500)
    // Tail-biased retention so the most recent events survive.
    const last = hydrated[hydrated.length - 1]
    expect(last.event_type).toBe('layer_loaded')
    if (last.event_type === 'layer_loaded') {
      expect(last.layer_id).toBe('ID_599')
    }
  })

  it('is a no-op on web (override=false)', () => {
    __setPersistOverrideForTests(false)
    persistQueue([layerLoaded('A')])
    expect(localStorage.getItem(PERSISTED_QUEUE_KEY)).toBeNull()
  })
})
