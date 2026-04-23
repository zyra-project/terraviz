import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { LayerLoadedEvent, DwellEvent, FeedbackEvent } from '../types'
import {
  emit,
  flush,
  size,
  getSessionId,
  tierGate,
  resetForTests,
  __peek,
  BATCH_SIZE,
  BATCH_INTERVAL_MS,
} from './emitter'
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
