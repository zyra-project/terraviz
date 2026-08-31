// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createVrZoomOverlay } from './vrZoomOverlay'

describe('vrZoomOverlay', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  function makeHandle(onZoom = vi.fn()) {
    return {
      handle: createVrZoomOverlay({
        onZoom,
        initialScale: 1.0,
        minScale: 0.3,
        maxScale: 2.5,
      }),
      onZoom,
    }
  }

  it('mount() appends the overlay to the parent', () => {
    const { handle } = makeHandle()
    handle.mount(document.body)
    expect(document.querySelector('.vr-zoom-overlay')).not.toBeNull()
  })

  it('mount() is idempotent — repeat calls do not duplicate the host', () => {
    const { handle } = makeHandle()
    handle.mount(document.body)
    handle.mount(document.body)
    expect(document.querySelectorAll('.vr-zoom-overlay').length).toBe(1)
  })

  it('unmount() removes the host but allows re-mount', () => {
    const { handle } = makeHandle()
    handle.mount(document.body)
    handle.unmount()
    expect(document.querySelector('.vr-zoom-overlay')).toBeNull()
    handle.mount(document.body)
    expect(document.querySelector('.vr-zoom-overlay')).not.toBeNull()
  })

  it('renders a vertical range slider with correct min/max', () => {
    const { handle } = makeHandle()
    handle.mount(document.body)
    const slider = document.querySelector('input[type="range"]') as HTMLInputElement
    expect(slider).not.toBeNull()
    expect(slider.min).toBe('0')
    expect(slider.max).toBe('1000')
    expect(slider.getAttribute('orient')).toBe('vertical')
  })

  it('positions the initial value at the log midpoint', () => {
    // Initial scale 1.0 between min 0.3 and max 2.5.
    // fractional position = (ln 1 - ln 0.3) / (ln 2.5 - ln 0.3)
    //                     = 1.20397 / 2.12026
    //                     ≈ 0.56784
    // Math.round(0.56784 * 1000) = 568 — assert exact since the
    // mapping is deterministic and the slider value is an integer.
    const { handle } = makeHandle()
    handle.mount(document.body)
    const slider = document.querySelector('input[type="range"]') as HTMLInputElement
    expect(Number(slider.value)).toBe(568)
  })

  it('fires onZoom on input with a log-mapped scale', () => {
    const { handle, onZoom } = makeHandle()
    handle.mount(document.body)
    const slider = document.querySelector('input[type="range"]') as HTMLInputElement
    // Drive to slider mid-position (500 / 1000) — log midpoint of
    // [0.3, 2.5] is sqrt(0.3 * 2.5) ≈ 0.866.
    slider.value = '500'
    slider.dispatchEvent(new Event('input'))
    expect(onZoom).toHaveBeenCalledTimes(1)
    expect(onZoom.mock.calls[0]?.[0]).toBeCloseTo(Math.sqrt(0.3 * 2.5), 5)
  })

  it('clamps slider extremes to min/max scale', () => {
    const { handle, onZoom } = makeHandle()
    handle.mount(document.body)
    const slider = document.querySelector('input[type="range"]') as HTMLInputElement
    slider.value = '0'
    slider.dispatchEvent(new Event('input'))
    expect(onZoom.mock.calls[0]?.[0]).toBeCloseTo(0.3, 5)
    slider.value = '1000'
    slider.dispatchEvent(new Event('input'))
    expect(onZoom.mock.calls[1]?.[0]).toBeCloseTo(2.5, 5)
  })

  it('setScale() updates the slider position from the outside', () => {
    const { handle } = makeHandle()
    handle.mount(document.body)
    const slider = document.querySelector('input[type="range"]') as HTMLInputElement
    handle.setScale(2.5) // max → slider 1000
    expect(Number(slider.value)).toBe(1000)
    handle.setScale(0.3) // min → slider 0
    expect(Number(slider.value)).toBe(0)
  })

  it('dispose() removes listeners and tears down DOM', () => {
    const { handle, onZoom } = makeHandle()
    handle.mount(document.body)
    const slider = document.querySelector('input[type="range"]') as HTMLInputElement
    handle.dispose()
    expect(document.querySelector('.vr-zoom-overlay')).toBeNull()
    // Detached handler — firing input shouldn't reach the callback.
    slider.dispatchEvent(new Event('input'))
    expect(onZoom).not.toHaveBeenCalled()
  })

  it('dispose() works when destructured off the handle (no `this` binding)', () => {
    // Regression for Copilot review of #96 — a `this.unmount()` body
    // would throw with TypeError once `dispose` is detached from the
    // handle object. Verify the destructured form works.
    const { handle } = makeHandle()
    handle.mount(document.body)
    const { dispose } = handle
    expect(() => dispose()).not.toThrow()
    expect(document.querySelector('.vr-zoom-overlay')).toBeNull()
  })

  it('uses logical inline-axis positioning for RTL safety (className probe)', () => {
    // Snapshot: the host carries the .vr-zoom-overlay class, whose
    // CSS uses inset-inline-end (verified by inspection in vr.css).
    // This test is a one-line guard that the class name doesn't drift
    // — actual RTL rendering belongs in a visual regression test.
    const { handle } = makeHandle()
    handle.mount(document.body)
    const host = document.querySelector('.vr-zoom-overlay')
    expect(host).not.toBeNull()
  })
})
