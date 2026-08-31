// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The probe source has to survive the buffered path.
 *
 * `updateTexture` / `setVideoTexture` buffer when the earth layer does
 * not exist yet, because MapLibre only builds it on the map's `load`
 * event. That branch used to apply the texture on load without ever
 * assigning `probeSource` / `probeOptions`, so a dataset that finished
 * loading *first* — a fast local asset, a warm cache, a fixtured
 * capture — reached the globe with no probe source at all.
 *
 * The symptom is the worst kind: the value readout reports nothing and
 * looks exactly like a dataset with nothing to report, and it stays
 * that way for as long as the dataset is on screen. It survived because
 * the race normally resolves the other way — a catalog fetch is slower
 * than map init — and because nothing asserted on it.
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MapRenderer } from './mapRenderer'
import type { DatasetOverlayOptions } from '../types'
import type { ColorScale } from '../types/color-scale'

const SCALE: ColorScale = {
  stops: [
    { t: 0, rgba: [0, 0, 0, 0] },
    { t: 1, rgba: [255, 255, 255, 255] },
  ],
  vmin: 0,
  vmax: 100,
  units: 'mg m-2',
}

const OPTIONS: DatasetOverlayOptions = {
  boundingBox: { n: 85, s: 5, w: -175, e: -20 },
  colorScale: SCALE,
}

/** A renderer with no earth layer, so texture calls take the buffering
 *  branch — the state the bug lived in. */
function bufferingRenderer(): MapRenderer {
  const r = new MapRenderer()
  ;(r as unknown as { earthLayer: unknown }).earthLayer = null
  return r
}

/** Stand in for the layer MapLibre builds on `load`, and run the same
 *  deferred-apply block the real `load` handler runs. */
function attachLayerAndFlush(r: MapRenderer): { setDatasetTexture: ReturnType<typeof vi.fn> } {
  const layer = {
    setDatasetTexture: vi.fn(),
    setDatasetVideo: vi.fn(),
    setColorScaleDisplay: vi.fn(),
  }
  const inner = r as unknown as {
    earthLayer: typeof layer
    pendingTexture: HTMLCanvasElement | HTMLImageElement | null
    pendingVideo: HTMLVideoElement | null
    pendingDatasetOptions: DatasetOverlayOptions | null
    probeSource: unknown
    probeOptions: DatasetOverlayOptions | null
    applyBaseLayerVisibility: (o?: DatasetOverlayOptions) => void
  }
  inner.earthLayer = layer
  inner.applyBaseLayerVisibility = () => {}

  // Mirrors the block inside the map `load` handler.
  if (inner.pendingTexture) {
    const opts = inner.pendingDatasetOptions ?? undefined
    layer.setDatasetTexture(inner.pendingTexture, opts)
    inner.probeSource = inner.pendingTexture
    inner.probeOptions = opts ?? null
    inner.pendingTexture = null
    inner.pendingDatasetOptions = null
  } else if (inner.pendingVideo) {
    const opts = inner.pendingDatasetOptions ?? undefined
    layer.setDatasetVideo(inner.pendingVideo, opts)
    inner.probeSource = inner.pendingVideo
    inner.probeOptions = opts ?? null
    inner.pendingVideo = null
    inner.pendingDatasetOptions = null
  }
  return layer
}

const probeState = (r: MapRenderer) =>
  r as unknown as { probeSource: unknown; probeOptions: DatasetOverlayOptions | null }

describe('probe source on the direct path', () => {
  it('is set when the layer already exists', () => {
    const r = new MapRenderer()
    const layer = { setDatasetTexture: vi.fn(), setColorScaleDisplay: vi.fn() }
    const inner = r as unknown as {
      earthLayer: unknown
      applyBaseLayerVisibility: () => void
    }
    inner.earthLayer = layer
    inner.applyBaseLayerVisibility = () => {}

    const img = document.createElement('canvas')
    r.updateTexture(img, OPTIONS)

    expect(probeState(r).probeSource).toBe(img)
    expect(probeState(r).probeOptions?.colorScale).toBe(SCALE)
  })
})

describe('probe source on the buffered path', () => {
  it('is set once the layer arrives, not left null', () => {
    const r = bufferingRenderer()
    const img = document.createElement('canvas')
    r.updateTexture(img, OPTIONS)

    // Buffered: nothing to probe yet, which is correct.
    expect(probeState(r).probeSource).toBeNull()

    const layer = attachLayerAndFlush(r)
    expect(layer.setDatasetTexture).toHaveBeenCalledWith(img, OPTIONS)
    // …and the probe source came with it. Asserting only the first half
    // is what let this ship.
    expect(probeState(r).probeSource).toBe(img)
    expect(probeState(r).probeOptions?.colorScale).toBe(SCALE)
  })

  it('carries the overlay options through, so the bbox is not lost', () => {
    // Without the options the UV mapping would treat a regional dataset
    // as global and place every texel at the wrong latitude.
    const r = bufferingRenderer()
    r.updateTexture(document.createElement('canvas'), OPTIONS)
    attachLayerAndFlush(r)
    expect(probeState(r).probeOptions?.boundingBox).toEqual(OPTIONS.boundingBox)
  })

  it('leaves options null when the caller passed none', () => {
    const r = bufferingRenderer()
    r.updateTexture(document.createElement('canvas'))
    attachLayerAndFlush(r)
    expect(probeState(r).probeOptions).toBeNull()
  })
})

describe('the real load handler', () => {
  // The tests above mirror the deferred-apply block rather than running
  // it: booting MapLibre far enough to fire `load` is not something
  // happy-dom can do. On its own that only pins the *intent*, and the
  // bug was in the real handler — so the handler's own source is
  // asserted here, the same technique `dataEncodedShaders.test.ts` uses
  // for code a unit test cannot reach.
  const source = readFileSync(resolve(process.cwd(), 'src/services/mapRenderer.ts'), 'utf-8')
    .replace(/\/\/[^\n]*/g, '')

  /** The `load` handler's deferred-apply block. */
  const deferred = source.slice(
    source.indexOf('if (this.pendingTexture)'),
    source.indexOf('Earth tile + capture + skybox layers added'),
  )

  it('exists where these tests think it does', () => {
    expect(deferred).toContain('setDatasetTexture')
    expect(deferred).toContain('setDatasetVideo')
  })

  it('assigns the probe source on both buffered branches', () => {
    // Two assignments, one per branch. Restoring only the image branch
    // would leave a buffered *video* — the common case for the shipped
    // data-encoded datasets, which are all HLS — silently unprobeable.
    expect(deferred.match(/this\.probeSource\s*=/g) ?? []).toHaveLength(2)
    expect(deferred.match(/this\.probeOptions\s*=/g) ?? []).toHaveLength(2)
    expect(deferred).toContain('this.probeSource = this.pendingTexture')
    expect(deferred).toContain('this.probeSource = this.pendingVideo')
  })

  it('clears the buffer only after the probe source is taken from it', () => {
    // `pendingTexture = null` before the assignment would store null and
    // reproduce the original bug with all the right lines present.
    const assignIdx = deferred.indexOf('this.probeSource = this.pendingTexture')
    const clearIdx = deferred.indexOf('this.pendingTexture = null')
    expect(assignIdx).toBeGreaterThan(-1)
    expect(clearIdx).toBeGreaterThan(assignIdx)
  })
})
