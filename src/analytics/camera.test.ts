import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  emitCameraSettled,
  canEmitCameraSettled,
  round,
  CAMERA_SETTLED_MAX_PER_MINUTE,
  __resetCameraThrottleForTests,
  __cameraThrottleWindowSize,
} from './camera'
import { resetForTests, __peek } from './emitter'
import { setTier } from './config'

beforeEach(() => {
  localStorage.clear()
  resetForTests()
  __resetCameraThrottleForTests()
  setTier('essential')
})

afterEach(() => {
  __resetCameraThrottleForTests()
})

// ---- Rounding ----

describe('camera.round', () => {
  it('rounds to the given decimals', () => {
    expect(round(1.23456, 3)).toBe(1.235)
    expect(round(-0.00049, 3)).toBe(0)
    expect(round(10, 0)).toBe(10)
  })

  it('never emits -0', () => {
    expect(Object.is(round(-0.0001, 3), -0)).toBe(false)
    expect(round(-0.0001, 3)).toBe(0)
  })

  it('returns 0 for non-finite input', () => {
    expect(round(NaN, 3)).toBe(0)
    expect(round(Infinity, 3)).toBe(0)
    expect(round(-Infinity, 3)).toBe(0)
  })
})

// ---- Emit + projection shape ----

describe('emitCameraSettled — payload shape', () => {
  it('emits a camera_settled event with rounded coordinates', () => {
    const ok = emitCameraSettled({
      slot_index: '0',
      projection: 'globe',
      center_lat: 51.50731,
      center_lon: -0.12779,
      zoom: 4.123456,
      bearing: 45.7,
      pitch: 12.4,
    })
    expect(ok).toBe(true)

    const evs = __peek()
    expect(evs).toHaveLength(1)
    const e = evs[0]
    if (e.event_type !== 'camera_settled') throw new Error('unreachable')
    expect(e.slot_index).toBe('0')
    expect(e.projection).toBe('globe')
    expect(e.center_lat).toBe(51.507)
    expect(e.center_lon).toBe(-0.128)
    expect(e.zoom).toBe(4.12)
    expect(e.bearing).toBe(46)
    expect(e.pitch).toBe(12)
    // layer_id defaults to null when caller doesn't supply one.
    expect(e.layer_id).toBeNull()
  })

  it('forwards a supplied layer_id verbatim', () => {
    emitCameraSettled({
      slot_index: '0',
      projection: 'globe',
      center_lat: 0,
      center_lon: 0,
      zoom: 1,
      bearing: 0,
      pitch: 0,
      layer_id: 'INTERNAL_SOS_42',
    })
    const ev = __peek()[0]
    if (ev.event_type !== 'camera_settled') throw new Error('unreachable')
    expect(ev.layer_id).toBe('INTERNAL_SOS_42')
  })

  it('coerces an explicit undefined layer_id to null', () => {
    emitCameraSettled({
      slot_index: '0',
      projection: 'vr',
      center_lat: 0,
      center_lon: 0,
      zoom: 1,
      bearing: 0,
      pitch: 0,
      layer_id: undefined,
    })
    const ev = __peek()[0]
    if (ev.event_type !== 'camera_settled') throw new Error('unreachable')
    expect(ev.layer_id).toBeNull()
  })

  it.each(['globe', 'mercator', 'vr', 'ar'] as const)(
    'accepts projection value %s',
    (projection) => {
      const ok = emitCameraSettled({
        slot_index: '0',
        projection,
        center_lat: 0,
        center_lon: 0,
        zoom: 1,
        bearing: 0,
        pitch: 0,
      })
      expect(ok).toBe(true)
      const ev = __peek()[0]
      if (ev.event_type !== 'camera_settled') throw new Error('unreachable')
      expect(ev.projection).toBe(projection)
    },
  )
})

// ---- Throttle ----

describe('emitCameraSettled — per-session throttle', () => {
  function fire(projection: 'globe' | 'vr' = 'globe'): boolean {
    return emitCameraSettled({
      slot_index: '0',
      projection,
      center_lat: 1,
      center_lon: 1,
      zoom: 1,
      bearing: 0,
      pitch: 0,
    })
  }

  it('accepts up to CAMERA_SETTLED_MAX_PER_MINUTE within a minute', () => {
    for (let i = 0; i < CAMERA_SETTLED_MAX_PER_MINUTE; i++) {
      expect(fire()).toBe(true)
    }
    expect(canEmitCameraSettled()).toBe(false)
    expect(fire()).toBe(false)
  })

  it('shares the budget across 2D and VR projections', () => {
    // Burn half the budget on 2D, then exhaust on VR.
    const half = Math.floor(CAMERA_SETTLED_MAX_PER_MINUTE / 2)
    for (let i = 0; i < half; i++) expect(fire('globe')).toBe(true)
    for (let i = 0; i < CAMERA_SETTLED_MAX_PER_MINUTE - half; i++) {
      expect(fire('vr')).toBe(true)
    }
    // Budget fully consumed — neither projection can fire now.
    expect(fire('globe')).toBe(false)
    expect(fire('vr')).toBe(false)
  })

  it('reclaims budget as entries age out of the window', () => {
    const base = 1_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(base)
    try {
      // Fill the budget at t=base.
      for (let i = 0; i < CAMERA_SETTLED_MAX_PER_MINUTE; i++) fire()
      expect(canEmitCameraSettled()).toBe(false)

      // Advance 59s — still no room (entries within 60s).
      nowSpy.mockReturnValue(base + 59_000)
      expect(canEmitCameraSettled()).toBe(false)

      // Advance 61s — every prior sample has aged out.
      nowSpy.mockReturnValue(base + 61_000)
      expect(canEmitCameraSettled()).toBe(true)
      expect(fire()).toBe(true)
    } finally {
      nowSpy.mockRestore()
      __resetCameraThrottleForTests()
    }
  })

  it('drops silently when over-budget — does not queue an event', () => {
    for (let i = 0; i < CAMERA_SETTLED_MAX_PER_MINUTE; i++) fire()
    const sizeBefore = __peek().length
    const ok = fire()
    expect(ok).toBe(false)
    expect(__peek().length).toBe(sizeBefore)
  })

  it('tracks the current window size for introspection', () => {
    expect(__cameraThrottleWindowSize()).toBe(0)
    fire()
    fire()
    expect(__cameraThrottleWindowSize()).toBe(2)
    __resetCameraThrottleForTests()
    expect(__cameraThrottleWindowSize()).toBe(0)
  })
})
