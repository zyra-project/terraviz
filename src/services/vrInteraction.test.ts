import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  emitVrInteraction,
  __resetVrInteractionThrottleForTests,
  VR_INTERACTION_MAX_PER_MINUTE,
} from './vrInteraction'
import { resetForTests, __peek, setTransport } from '../analytics/emitter'
import { setTier } from '../analytics/config'
import type { TelemetryEvent } from '../types'
import type { Transport } from '../analytics/transport'

/** Capturing transport that records every event handed to flush so
 * the test can assert against the cumulative emit count even when
 * BATCH_SIZE-driven auto-flushes drain the in-memory queue. */
function captureTransport(): { sent: TelemetryEvent[]; transport: Transport } {
  const sent: TelemetryEvent[] = []
  const transport: Transport = {
    endpoint: 'test://capture',
    async send(_sessionId, events) {
      sent.push(...events)
      return { ok: true, retryable: false, permanent: false, status: 204 }
    },
    sendBeacon(_sessionId, events) {
      sent.push(...events)
      return true
    },
  }
  return { sent, transport }
}

beforeEach(() => {
  localStorage.clear()
  resetForTests()
  __resetVrInteractionThrottleForTests()
  setTier('research')
})

afterEach(() => {
  __resetVrInteractionThrottleForTests()
  vi.restoreAllMocks()
})

describe('emitVrInteraction — Tier-B vr_interaction emit', () => {
  it('emits a vr_interaction event with the gesture and rounded magnitude', () => {
    emitVrInteraction('drag', 1.234567)
    const events = __peek().filter((e) => e.event_type === 'vr_interaction')
    expect(events).toHaveLength(1)
    const e = events[0]
    if (e.event_type !== 'vr_interaction') throw new Error('unreachable')
    expect(e.gesture).toBe('drag')
    expect(e.magnitude).toBe(1.23)
  })

  it('drops the event when the tier is below research', () => {
    setTier('essential')
    emitVrInteraction('drag', 1)
    expect(__peek().filter((e) => e.event_type === 'vr_interaction')).toHaveLength(0)
    setTier('off')
    emitVrInteraction('drag', 1)
    expect(__peek().filter((e) => e.event_type === 'vr_interaction')).toHaveLength(0)
  })

  it('rounds magnitude to 2 decimals', () => {
    emitVrInteraction('thumbstick_zoom', 0.999)
    const e = __peek().find((x) => x.event_type === 'vr_interaction')
    if (!e || e.event_type !== 'vr_interaction') throw new Error('unreachable')
    expect(e.magnitude).toBe(1)
  })
})

describe('emitVrInteraction — per-gesture throttle', () => {
  it('caps each gesture at VR_INTERACTION_MAX_PER_MINUTE per minute', async () => {
    const { sent, transport } = captureTransport()
    setTransport(transport)
    const base = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(base)
    for (let i = 0; i < VR_INTERACTION_MAX_PER_MINUTE + 5; i++) {
      emitVrInteraction('drag', 0.1)
    }
    // Drain the residual queue into the capture transport.
    const { flush } = await import('../analytics/emitter')
    flush()
    const dragEvents = sent.filter(
      (e) => e.event_type === 'vr_interaction' && e.gesture === 'drag',
    )
    expect(dragEvents).toHaveLength(VR_INTERACTION_MAX_PER_MINUTE)
    nowSpy.mockRestore()
  })

  it('throttles each gesture independently', async () => {
    const { sent, transport } = captureTransport()
    setTransport(transport)
    const base = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(base)
    for (let i = 0; i < VR_INTERACTION_MAX_PER_MINUTE + 3; i++) {
      emitVrInteraction('drag', 0.1)
    }
    emitVrInteraction('pinch', 0.5)
    const { flush } = await import('../analytics/emitter')
    flush()
    const dragEvents = sent.filter(
      (e) => e.event_type === 'vr_interaction' && e.gesture === 'drag',
    )
    const pinchEvents = sent.filter(
      (e) => e.event_type === 'vr_interaction' && e.gesture === 'pinch',
    )
    expect(dragEvents).toHaveLength(VR_INTERACTION_MAX_PER_MINUTE)
    expect(pinchEvents).toHaveLength(1)
    nowSpy.mockRestore()
  })

  it('admits new events after the window slides forward', async () => {
    const { sent, transport } = captureTransport()
    setTransport(transport)
    const base = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(base)
    for (let i = 0; i < VR_INTERACTION_MAX_PER_MINUTE; i++) {
      emitVrInteraction('hud_tap', 1)
    }
    // One more inside the window — dropped.
    emitVrInteraction('hud_tap', 1)
    // Slide the clock forward past the window; throttle entries age out.
    nowSpy.mockReturnValue(base + 61_000)
    emitVrInteraction('hud_tap', 1)
    const { flush } = await import('../analytics/emitter')
    flush()
    const hudEvents = sent.filter(
      (e) => e.event_type === 'vr_interaction' && e.gesture === 'hud_tap',
    )
    expect(hudEvents).toHaveLength(VR_INTERACTION_MAX_PER_MINUTE + 1)
    nowSpy.mockRestore()
  })
})
