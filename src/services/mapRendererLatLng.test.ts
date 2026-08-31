// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it, vi } from 'vitest'
import { MapRenderer } from './mapRenderer'

/**
 * The lat/lng callbacks are what the data-encoded value readout hangs
 * off, so "the handler never fires" is a silent failure rather than a
 * loud one: the coordinate strip simply stays empty and looks like a
 * dataset with nothing to report.
 *
 * `Evented.on` takes any string, so a misspelled or invented event
 * name type-checks, registers, and never runs. These tests pin the
 * names against the ones MapLibre documents as firing.
 */

/** Events MapLibre GL JS fires on the map for pointer motion. */
const REAL_MAP_EVENTS = new Set([
  'click', 'contextmenu', 'dblclick',
  'mousemove', 'mouseup', 'mousedown', 'mouseout', 'mouseover',
  'touchstart', 'touchmove', 'touchend', 'touchcancel',
])

interface FakeMap {
  on: ReturnType<typeof vi.fn>
  off: ReturnType<typeof vi.fn>
  project: (lngLat: { lng: number; lat: number }) => { x: number; y: number }
  handlers: Map<string, Set<(e: unknown) => void>>
  fire: (type: string, e: unknown) => void
}

function fakeMap(): FakeMap {
  const handlers = new Map<string, Set<(e: unknown) => void>>()
  const map = {
    handlers,
    on: vi.fn((type: string, fn: (e: unknown) => void) => {
      if (!handlers.has(type)) handlers.set(type, new Set())
      handlers.get(type)!.add(fn)
    }),
    off: vi.fn((type: string, fn: (e: unknown) => void) => {
      handlers.get(type)?.delete(fn)
    }),
    // Identity round trip: every point is "on the globe" unless the
    // test says otherwise by passing a mismatched screen point.
    project: (lngLat: { lng: number; lat: number }) => ({ x: lngLat.lng, y: lngLat.lat }),
    fire: (type: string, e: unknown) => {
      for (const fn of handlers.get(type) ?? []) fn(e)
    },
  }
  return map as FakeMap
}

/** Attach a fake map to a renderer without booting MapLibre. */
function rendererWith(map: FakeMap): MapRenderer {
  const renderer = new MapRenderer()
  ;(renderer as unknown as { map: unknown }).map = map
  return renderer
}

const at = (lng: number, lat: number) => ({ lngLat: { lng, lat }, point: { x: lng, y: lat } })

describe('setLatLngCallbacks', () => {
  it('registers only events MapLibre actually fires', () => {
    const map = fakeMap()
    rendererWith(map).setLatLngCallbacks(vi.fn(), vi.fn())

    const registered = map.on.mock.calls.map(([type]) => type as string)
    expect(registered.length).toBeGreaterThan(0)
    for (const type of registered) {
      expect(REAL_MAP_EVENTS, `map.on('${type}') is not a MapLibre map event`).toContain(type)
    }
  })

  it('reports on mouse motion and on a touch drag', () => {
    const map = fakeMap()
    const onUpdate = vi.fn()
    rendererWith(map).setLatLngCallbacks(onUpdate, vi.fn())

    map.fire('mousemove', at(12, 34))
    expect(onUpdate).toHaveBeenCalledWith(34, 12)

    // A finger drag has to read out too — it is the only way to probe
    // a value on a phone.
    map.fire('touchmove', at(-5, 40))
    expect(onUpdate).toHaveBeenNthCalledWith(2, 40, -5)
  })

  it('clears when the cursor leaves the canvas or the sphere', () => {
    const map = fakeMap()
    const onUpdate = vi.fn()
    const onClear = vi.fn()
    rendererWith(map).setLatLngCallbacks(onUpdate, onClear)

    map.fire('mouseout', {})
    expect(onClear).toHaveBeenCalledTimes(1)

    // Off-globe: the round trip does not land back on the screen point,
    // so empty space beside the sphere reports nothing rather than a
    // coordinate MapLibre unprojected anyway.
    map.fire('mousemove', { lngLat: { lng: 12, lat: 34 }, point: { x: 900, y: 900 } })
    expect(onClear).toHaveBeenCalledTimes(2)
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('replaces the previous handlers instead of stacking them', () => {
    const map = fakeMap()
    const renderer = rendererWith(map)
    const first = vi.fn()
    const second = vi.fn()

    renderer.setLatLngCallbacks(first, vi.fn())
    renderer.setLatLngCallbacks(second, vi.fn())
    map.fire('mousemove', at(1, 2))

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
