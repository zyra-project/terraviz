import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { LayerLoadedEvent, DwellEvent, FeedbackEvent } from '../types'
import {
  emit,
  flush,
  flushOnUnload,
  setTransport,
  size,
  getSessionId,
  tierGate,
  applyTierChange,
  resetForTests,
  __peek,
  __awaitInflight,
  __transportState,
  BATCH_SIZE,
  BATCH_INTERVAL_MS,
  BACKOFF_STEPS_MS,
} from './emitter'
import type { Transport } from './transport'
import { PERSISTED_QUEUE_KEY, __setPersistOverrideForTests } from './transport'
import { setTier } from './config'

// --- Fixtures ---

function layerLoaded(id = 'TEST_DATASET'): LayerLoadedEvent {
  return {
    event_type: 'layer_loaded',
    layer_id: id,
    layer_source: 'network',
    slot_index: '0',
    trigger: 'browse',
    load_ms: 1234,
  }
}

function dwell(target: 'chat' = 'chat'): DwellEvent {
  return {
    event_type: 'dwell',
    view_target: target,
    duration_ms: 4000,
  }
}

function feedback(): FeedbackEvent {
  return {
    event_type: 'feedback',
    context: 'ai_response',
    kind: 'thumbs_up',
    status: 'ok',
    rating: 1,
  }
}

// --- Tests ---

describe('emitter — tier gate', () => {
  beforeEach(() => {
    localStorage.clear()
    resetForTests()
  })

  it('drops every event when tier is off', () => {
    setTier('off')
    emit(layerLoaded())
    emit(feedback())
    emit(dwell())
    expect(size()).toBe(0)
  })

  it('accepts Tier A events and drops Tier B events on essential', () => {
    setTier('essential')
    emit(layerLoaded())
    emit(feedback())
    emit(dwell()) // Tier B — should be dropped
    expect(size()).toBe(2)
    const drained = flush()
    expect(drained.map((e) => e.event_type)).toEqual(['layer_loaded', 'feedback'])
  })

  it('accepts Tier A and Tier B on research', () => {
    setTier('research')
    emit(layerLoaded())
    emit(dwell())
    expect(size()).toBe(2)
  })

  it('tierGate is a pure function of tier + event type', () => {
    setTier('essential')
    expect(tierGate('layer_loaded')).toBe(true)
    expect(tierGate('dwell')).toBe(false)
    setTier('research')
    expect(tierGate('dwell')).toBe(true)
    setTier('off')
    expect(tierGate('layer_loaded')).toBe(false)
  })
})

describe('emitter — batching', () => {
  beforeEach(() => {
    localStorage.clear()
    resetForTests()
    setTier('essential')
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('auto-flushes when the queue reaches BATCH_SIZE', () => {
    for (let i = 0; i < BATCH_SIZE - 1; i++) emit(layerLoaded(`ID_${i}`))
    expect(size()).toBe(BATCH_SIZE - 1)
    emit(layerLoaded('TRIGGER'))
    expect(size()).toBe(0) // size-based flush triggered
  })

  it('auto-flushes after BATCH_INTERVAL_MS elapses', () => {
    emit(layerLoaded())
    expect(size()).toBe(1)
    vi.advanceTimersByTime(BATCH_INTERVAL_MS - 1)
    expect(size()).toBe(1)
    vi.advanceTimersByTime(1)
    expect(size()).toBe(0)
  })

  it('does not schedule multiple concurrent flush timers', () => {
    emit(layerLoaded('A'))
    emit(layerLoaded('B'))
    emit(layerLoaded('C'))
    // All three enqueued under the same scheduled flush.
    expect(size()).toBe(3)
    vi.advanceTimersByTime(BATCH_INTERVAL_MS)
    expect(size()).toBe(0)
  })

  it('manual flush drains the queue and clears the pending timer', () => {
    emit(layerLoaded('A'))
    emit(layerLoaded('B'))
    const drained = flush()
    expect(drained).toHaveLength(2)
    expect(size()).toBe(0)
    // No timer should fire now.
    vi.advanceTimersByTime(BATCH_INTERVAL_MS)
    expect(size()).toBe(0)
  })

  it('manual flush on an empty queue returns an empty array', () => {
    expect(flush()).toEqual([])
  })
})

describe('emitter — client_offset_ms stamping', () => {
  beforeEach(() => {
    localStorage.clear()
    resetForTests()
    setTier('essential')
  })

  it('stamps every emitted event with a non-negative offset', () => {
    emit(layerLoaded())
    const [event] = __peek()
    expect(event?.client_offset_ms).toBeGreaterThanOrEqual(0)
  })

  it('offsets increase monotonically across successive emits', async () => {
    emit(layerLoaded('A'))
    // Yield to let performance.now advance. Works under happy-dom.
    await new Promise((resolve) => setTimeout(resolve, 5))
    emit(layerLoaded('B'))
    const events = __peek()
    const [a, b] = events
    expect(b?.client_offset_ms).toBeGreaterThanOrEqual(a?.client_offset_ms ?? 0)
  })
})

describe('emitter — applyTierChange (Commit 5)', () => {
  beforeEach(() => {
    localStorage.clear()
    resetForTests()
  })

  it('drops every queued event when switching to Off', () => {
    setTier('research')
    emit(layerLoaded('A'))
    emit(dwell())
    emit(feedback())
    expect(size()).toBe(3)

    // User flips Tools → Privacy to Off. Queue must be emptied so
    // events captured under consent are not flushed post-consent.
    setTier('off')
    applyTierChange('off')
    expect(size()).toBe(0)

    // Subsequent emits no-op (tier gate handles this separately).
    emit(layerLoaded('B'))
    expect(size()).toBe(0)
  })

  it('strips queued Tier B events on Research → Essential', () => {
    setTier('research')
    emit(layerLoaded('A')) // Tier A — should survive
    emit(dwell()) // Tier B — should be stripped
    emit(feedback()) // Tier A — should survive
    expect(size()).toBe(3)

    setTier('essential')
    applyTierChange('essential')

    const remaining = __peek().map((e) => e.event_type)
    expect(remaining).toEqual(['layer_loaded', 'feedback'])
  })

  it('keeps the queue intact on Essential → Research', () => {
    setTier('essential')
    emit(layerLoaded('A'))
    emit(feedback())
    expect(size()).toBe(2)

    setTier('research')
    applyTierChange('research')

    expect(size()).toBe(2)
  })

  it('does not backfill previously-dropped events after Off → On', () => {
    setTier('essential')
    emit(layerLoaded('A'))
    emit(feedback())

    setTier('off')
    applyTierChange('off')
    expect(size()).toBe(0)

    setTier('essential')
    applyTierChange('essential')
    // Switching back on must not resurrect the dropped events.
    expect(size()).toBe(0)

    emit(layerLoaded('B'))
    expect(size()).toBe(1)
  })

  it('clears the scheduled flush timer when switching to Off', () => {
    vi.useFakeTimers()
    try {
      setTier('essential')
      emit(layerLoaded('A'))
      expect(size()).toBe(1)

      setTier('off')
      applyTierChange('off')
      expect(size()).toBe(0)

      // If applyTierChange forgot to clear the timer, a delayed flush
      // would still try to run — we're just asserting the queue stays
      // empty through the interval.
      vi.advanceTimersByTime(BATCH_INTERVAL_MS * 2)
      expect(size()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('emitter — privacy page URL gate', () => {
  const originalPath = window.location.pathname

  beforeEach(() => {
    localStorage.clear()
    resetForTests()
    setTier('research') // most permissive — proves the gate runs before the tier check
  })

  afterEach(() => {
    window.history.pushState(null, '', originalPath)
  })

  it('no-ops on /privacy regardless of tier', () => {
    window.history.pushState(null, '', '/privacy')
    emit(layerLoaded())
    emit(dwell())
    emit(feedback())
    expect(size()).toBe(0)
  })

  it('no-ops on /privacy.html regardless of tier', () => {
    window.history.pushState(null, '', '/privacy.html')
    emit(layerLoaded())
    emit(dwell())
    expect(size()).toBe(0)
  })

  it('emits normally on other paths', () => {
    window.history.pushState(null, '', '/')
    emit(layerLoaded())
    expect(size()).toBe(1)

    resetForTests()
    setTier('research')
    window.history.pushState(null, '', '/some/deep/route')
    emit(layerLoaded())
    expect(size()).toBe(1)
  })

  it('does not match unrelated paths that contain "privacy" as a substring', () => {
    window.history.pushState(null, '', '/not-privacy')
    emit(layerLoaded())
    expect(size()).toBe(1)
  })
})

describe('emitter — session ID', () => {
  beforeEach(() => {
    localStorage.clear()
    resetForTests()
  })

  it('exposes the in-memory session ID', () => {
    const id = getSessionId()
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  it('rotates the session ID on resetForTests (stand-in for app relaunch)', () => {
    const first = getSessionId()
    resetForTests()
    const second = getSessionId()
    expect(first).not.toBe(second)
  })

  it('never writes the session ID to localStorage', () => {
    getSessionId()
    emit(layerLoaded())
    const keys = Object.keys(localStorage)
    const values = keys.map((k) => localStorage.getItem(k) ?? '')
    for (const v of values) {
      expect(v).not.toContain(getSessionId())
    }
  })
})

// ---------------------------------------------------------------
// Commit 6 — transport dispatch, backoff, cooldown, pagehide
// ---------------------------------------------------------------

type SendMock = ReturnType<
  typeof vi.fn<(sessionId: string, events: readonly unknown[]) => void>
>
type BeaconMock = ReturnType<
  typeof vi.fn<(sessionId: string, events: readonly unknown[]) => boolean>
>

type MockTransport = Transport & {
  sendMock: SendMock
  beaconMock: BeaconMock
  sendResults: Array<{
    status: number | null
    ok: boolean
    retryable: boolean
    permanent: boolean
  }>
}

function makeTransport(): MockTransport {
  const sendMock: SendMock = vi.fn()
  const beaconMock: BeaconMock = vi.fn(() => true)
  const t: MockTransport = {
    sendMock,
    beaconMock,
    sendResults: [],
    endpoint: '/mock/ingest',
    async send(sessionId, events) {
      sendMock(sessionId, events)
      const next = t.sendResults.shift() ?? {
        status: 204, ok: true, retryable: false, permanent: false,
      }
      return next
    },
    sendBeacon(sessionId, events) {
      return beaconMock(sessionId, events)
    },
  }
  return t
}

describe('emitter — transport dispatch', () => {
  beforeEach(() => {
    localStorage.clear()
    resetForTests()
    setTier('essential')
    __setPersistOverrideForTests(false)
  })

  afterEach(() => {
    __setPersistOverrideForTests(null)
    resetForTests()
  })

  it('hands off flushed events to the transport', async () => {
    const t = makeTransport()
    setTransport(t)
    emit(layerLoaded('A'))
    emit(layerLoaded('B'))
    flush()
    await __awaitInflight()
    expect(t.sendMock).toHaveBeenCalledTimes(1)
    const [, sent] = t.sendMock.mock.calls[0]
    expect(sent).toHaveLength(2)
  })

  it('clears the queue on 204 and resets the backoff index', async () => {
    const t = makeTransport()
    setTransport(t)
    emit(layerLoaded('A'))
    flush()
    await __awaitInflight()
    expect(size()).toBe(0)
    expect(__transportState().backoffIndex).toBe(0)
    expect(__transportState().cooledDown).toBe(false)
  })

  it('cools down the session on 410 and drops the batch', async () => {
    const t = makeTransport()
    t.sendResults.push({ status: 410, ok: false, retryable: false, permanent: true })
    setTransport(t)
    emit(layerLoaded('A'))
    emit(layerLoaded('B'))
    flush()
    await __awaitInflight()

    expect(__transportState().cooledDown).toBe(true)
    // Subsequent flushes are no-ops — no more POSTs happen.
    emit(layerLoaded('C'))
    flush()
    await __awaitInflight()
    expect(t.sendMock).toHaveBeenCalledTimes(1)
  })

  it('re-queues and steps backoff on a 503', async () => {
    const t = makeTransport()
    t.sendResults.push({ status: 503, ok: false, retryable: true, permanent: false })
    setTransport(t)

    emit(layerLoaded('A'))
    emit(layerLoaded('B'))
    flush()
    await __awaitInflight()

    expect(size()).toBe(2)
    expect(__transportState().backoffIndex).toBe(1)
    expect(__transportState().nextSendAllowedAt).toBeGreaterThan(Date.now())
  })

  it('re-queues on a network error (null status)', async () => {
    const t = makeTransport()
    t.sendResults.push({ status: null, ok: false, retryable: true, permanent: false })
    setTransport(t)

    emit(layerLoaded('A'))
    flush()
    await __awaitInflight()

    expect(size()).toBe(1)
    expect(__transportState().backoffIndex).toBe(1)
  })

  it('escalates backoff on repeated 5xx and clamps at the last step', async () => {
    // Use a monotonically-advancing fake clock so the pre-flight
    // backoff gate lets every retry through.
    let now = 1_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const t = makeTransport()
      const attempts = BACKOFF_STEPS_MS.length + 3
      for (let i = 0; i < attempts; i++) {
        t.sendResults.push({
          status: 503, ok: false, retryable: true, permanent: false,
        })
      }
      setTransport(t)

      for (let i = 0; i < attempts; i++) {
        emit(layerLoaded(`ID_${i}`))
        flush()
        await __awaitInflight()
        // Advance past the just-set backoff window so the NEXT flush
        // is allowed through the pre-flight gate.
        now = __transportState().nextSendAllowedAt + 1
      }

      expect(__transportState().backoffIndex).toBe(BACKOFF_STEPS_MS.length - 1)
      expect(t.sendMock.mock.calls.length).toBeGreaterThanOrEqual(
        BACKOFF_STEPS_MS.length,
      )
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('drops the batch on a non-retryable 4xx without cooldown', async () => {
    const t = makeTransport()
    t.sendResults.push({ status: 400, ok: false, retryable: false, permanent: false })
    setTransport(t)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    emit(layerLoaded('A'))
    flush()
    await __awaitInflight()
    warnSpy.mockRestore()

    expect(size()).toBe(0)
    expect(__transportState().cooledDown).toBe(false)
    expect(__transportState().backoffIndex).toBe(0)
  })

  it('re-queues without calling the server when within a backoff window', async () => {
    const t = makeTransport()
    // Step 1: a 503 pushes us into backoff.
    t.sendResults.push({ status: 503, ok: false, retryable: true, permanent: false })
    setTransport(t)
    emit(layerLoaded('A'))
    flush()
    await __awaitInflight()
    expect(t.sendMock).toHaveBeenCalledTimes(1)
    expect(size()).toBe(1)

    // Step 2: calling flush again before nextSendAllowedAt should NOT
    // hit the server — the dispatch loop's pre-flight gate re-queues.
    flush()
    await __awaitInflight()
    expect(t.sendMock).toHaveBeenCalledTimes(1)
    expect(size()).toBe(1)
  })

  it('hydrates a persisted queue when the transport is wired', () => {
    __setPersistOverrideForTests(true)
    localStorage.setItem(
      PERSISTED_QUEUE_KEY,
      JSON.stringify([layerLoaded('PERSISTED_A'), layerLoaded('PERSISTED_B')]),
    )

    const t = makeTransport()
    setTransport(t)

    expect(size()).toBe(2)
  })
})

describe('emitter — flushOnUnload / pagehide', () => {
  beforeEach(() => {
    localStorage.clear()
    resetForTests()
    setTier('essential')
    __setPersistOverrideForTests(false)
  })

  afterEach(() => {
    __setPersistOverrideForTests(null)
    resetForTests()
  })

  it('fires a single beacon for pending events on unload', () => {
    const t = makeTransport()
    setTransport(t)

    emit(layerLoaded('A'))
    emit(layerLoaded('B'))
    expect(size()).toBe(2)

    flushOnUnload()

    expect(t.beaconMock).toHaveBeenCalledTimes(1)
    expect(size()).toBe(0)
  })

  it('persists the queue when the browser rejects the beacon (Tauri)', () => {
    __setPersistOverrideForTests(true)
    const t = makeTransport()
    const rejectedBeacon: BeaconMock = vi.fn(() => false)
    t.beaconMock = rejectedBeacon
    t.sendBeacon = (sid, ev) => rejectedBeacon(sid, ev)
    setTransport(t)

    emit(layerLoaded('A'))
    flushOnUnload()

    // Events re-queued for the next launch, and persisted.
    expect(size()).toBe(1)
    expect(localStorage.getItem(PERSISTED_QUEUE_KEY)).not.toBeNull()
  })

  it('is a no-op on unload when the session is cooled down', () => {
    const t = makeTransport()
    t.sendResults.push({ status: 410, ok: false, retryable: false, permanent: true })
    setTransport(t)
    emit(layerLoaded('A'))
    flush()

    // After the 410 cooldown takes effect, flushOnUnload must not
    // fire a beacon for any later events.
    return __awaitInflight().then(() => {
      expect(__transportState().cooledDown).toBe(true)
      emit(layerLoaded('B'))
      flushOnUnload()
      expect(t.beaconMock).not.toHaveBeenCalled()
    })
  })

  it('wires a pagehide listener on setTransport', () => {
    const t = makeTransport()
    setTransport(t)

    emit(layerLoaded('A'))
    expect(size()).toBe(1)

    window.dispatchEvent(new Event('pagehide'))

    expect(t.beaconMock).toHaveBeenCalledTimes(1)
    expect(size()).toBe(0)
  })
})
