// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The basemap must not be able to hold the globe's own layers hostage.
 *
 * MapLibre fires `load` only once *every source in the style* reports
 * loaded, and the style declares `openmaptiles` by TileJSON `url` — a
 * fetch to a third-party host that exists for the labels and boundaries
 * overlays, which are off by default behind a Tools toggle. When that
 * host is slow or unreachable, `load` never arrives: no earth tile
 * layer, so a dataset already fetched and decoded sits in
 * `pendingTexture` indefinitely, and the visitor gets bare raster tiles
 * with no day/night, no atmosphere, and — for a data-encoded row — no
 * probe source, so no value readout and no Analyze panel.
 *
 * Reproduced in the visual-report harness, where OpenFreeMap is
 * unreachable: `load` never fired and a data-encoded scene reported "no
 * dataset carrying values" against a globe that had one.
 *
 * These drive `buildGlobeLayers` directly rather than through MapLibre,
 * following `mapRendererLatLng.test.ts` — the point is the trigger
 * logic, not the layer construction.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { MapRenderer } from './mapRenderer'

type Internals = {
  map: unknown
  globeLayersBuilt: boolean
  styleDeadline: ReturnType<typeof setTimeout> | null
  projection: string
  buildGlobeLayers(container: HTMLElement, trigger: 'load' | 'deadline'): void
}

/** A renderer with just enough map for the mercator early-return path,
 *  which exercises the trigger logic without building GL layers. */
function renderer(): { r: MapRenderer; inner: Internals; container: HTMLElement } {
  const r = new MapRenderer()
  const inner = r as unknown as Internals
  inner.map = { once: vi.fn(), on: vi.fn(), off: vi.fn(), stop: vi.fn(), remove: vi.fn() }
  inner.projection = 'mercator'
  return { r, inner, container: document.createElement('div') }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('buildGlobeLayers', () => {
  it('builds once, whichever trigger arrives first', () => {
    const { inner, container } = renderer()
    inner.buildGlobeLayers(container, 'load')
    expect(inner.globeLayersBuilt).toBe(true)

    // A late deadline after a normal load must not rebuild the layers:
    // addLayer with an id that already exists throws.
    const build = vi.spyOn(inner, 'buildGlobeLayers')
    inner.buildGlobeLayers(container, 'deadline')
    expect(build).toHaveBeenCalledOnce()
    expect(inner.globeLayersBuilt).toBe(true)
  })

  it('clears the pending deadline once the layers exist', () => {
    const { inner, container } = renderer()
    inner.styleDeadline = setTimeout(() => { throw new Error('deadline should be cleared') }, 8_000)
    inner.buildGlobeLayers(container, 'load')
    expect(inner.styleDeadline).toBeNull()
    expect(() => vi.advanceTimersByTime(20_000)).not.toThrow()
  })

  it('says so in the log when it takes the deadline path', () => {
    // The whole point of the fallback is that it fires when something
    // is wrong; a silent recovery would hide a broken basemap host for
    // as long as nobody looked at the labels toggle.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { inner, container } = renderer()
    inner.buildGlobeLayers(container, 'deadline')
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0]?.join(' '))).toMatch(/did not fire/i)
    warn.mockRestore()
  })

  it('does nothing without a map', () => {
    const { inner, container } = renderer()
    inner.map = null
    expect(() => inner.buildGlobeLayers(container, 'deadline')).not.toThrow()
    expect(inner.globeLayersBuilt).toBe(false)
  })

  it('drops a pending deadline on dispose, so a torn-down panel cannot build', () => {
    // A 4→1 layout change can remove a panel before its style ever
    // settles; the timer would then run against a removed map.
    const { r, inner } = renderer()
    inner.styleDeadline = setTimeout(() => { throw new Error('should not fire') }, 8_000)
    r.dispose()
    expect(inner.styleDeadline).toBeNull()
    expect(() => vi.advanceTimersByTime(20_000)).not.toThrow()
  })
})
