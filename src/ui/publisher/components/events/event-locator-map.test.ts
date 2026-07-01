/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock MapLibre so no WebGL / tile fetching happens in the test.
const mapStub = vi.hoisted(() => {
  const remove = vi.fn()
  const addTo = vi.fn()
  const setLngLat = vi.fn(() => ({ addTo }))
  const instances: Array<{ opts: Record<string, unknown> }> = []
  class Map {
    opts: Record<string, unknown>
    remove = remove
    constructor(opts: Record<string, unknown>) {
      this.opts = opts
      instances.push(this)
    }
  }
  class Marker {
    setLngLat = setLngLat
    constructor(_o: unknown) { void _o }
  }
  return { Map, Marker, remove, setLngLat, addTo, instances }
})

vi.mock('maplibre-gl', () => ({ default: { Map: mapStub.Map, Marker: mapStub.Marker } }))
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}))

import { mountEventLocator } from './event-locator-map'

const tick = () => new Promise<void>(r => setTimeout(r, 0))

describe('mountEventLocator', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="slot"></div>'
    mapStub.instances.length = 0
    mapStub.remove.mockClear()
  })

  it('mounts a non-interactive map centred on the point, then disposes it', async () => {
    const slot = document.getElementById('slot')!
    const dispose = mountEventLocator(slot, { lat: 46.4, lon: -117.2 })
    await tick() // let the lazy maplibre-gl import resolve

    expect(mapStub.instances).toHaveLength(1)
    expect(mapStub.instances[0].opts.center).toEqual([-117.2, 46.4]) // [lon, lat]
    expect(mapStub.instances[0].opts.interactive).toBe(false)
    expect(slot.querySelector('.publisher-events-locator-canvas')).not.toBeNull()
    expect(mapStub.setLngLat).toHaveBeenCalledWith([-117.2, 46.4])

    dispose()
    expect(mapStub.remove).toHaveBeenCalled()
  })

  it('cancels the mount when disposed before the map finishes loading', async () => {
    const slot = document.getElementById('slot')!
    const dispose = mountEventLocator(slot, { lat: 0, lon: 0 })
    dispose() // dispose before the lazy import resolves
    await tick()
    expect(mapStub.instances).toHaveLength(0)
  })
})
