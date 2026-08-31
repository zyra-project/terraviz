// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the Phase 3e dataset-overlay options helpers.
 *
 * Both functions are pure, no DOM / WebGL involvement — vitest
 * with happy-dom (the SPA's default test env) covers them
 * directly. The WebGL shader path that actually consumes the
 * returned options is integration-only and tested in the
 * browser.
 */

import { describe, expect, it } from 'vitest'
import { isEarthBody, overlayOptionsFromDataset } from './datasetOverlayOptions'
import type { ColorScale, Dataset } from '../types'

function makeDataset(over: Partial<Dataset> = {}): Dataset {
  return {
    id: 'DS_X',
    title: 'Test',
    format: 'video/mp4',
    dataLink: 'https://example.org/x.mp4',
    ...over,
  }
}

describe('isEarthBody', () => {
  it('treats null / undefined as Earth (catalog row carries no body)', () => {
    expect(isEarthBody(null)).toBe(true)
    expect(isEarthBody(undefined)).toBe(true)
  })

  it('treats empty / whitespace string as Earth (SOS-snapshot convention)', () => {
    expect(isEarthBody('')).toBe(true)
    expect(isEarthBody('   ')).toBe(true)
  })

  it('is case-insensitive on "Earth"', () => {
    expect(isEarthBody('Earth')).toBe(true)
    expect(isEarthBody('EARTH')).toBe(true)
    expect(isEarthBody('earth')).toBe(true)
    expect(isEarthBody('  EaRtH  ')).toBe(true)
  })

  it('returns false for every non-Earth body in the SOS snapshot', () => {
    const bodies = [
      'Mars', 'Moon', 'Sun', 'Jupiter', 'Saturn', 'Mercury', 'Venus',
      'Pluto', 'Neptune', 'Uranus', 'Io', 'Europa', 'Ganymede',
      'Callisto', 'Enceladus', 'Titan', '67p', 'aurora',
      'Trappist-1d', 'Exoplanet Kepler-10b',
    ]
    for (const body of bodies) {
      expect(isEarthBody(body)).toBe(false)
    }
  })

  it('treats "aurora" as non-Earth even though it\'s an Earth phenomenon', () => {
    // Documented in the helper comment: the renderer trusts the
    // catalog row. Aurora datasets in the SOS snapshot persist
    // celestialBody="aurora" verbatim; treating them as non-Earth
    // hides the blue marble base which is fine — the dataset's
    // own auroral oval imagery is the visible content.
    expect(isEarthBody('aurora')).toBe(false)
  })
})

describe('overlayOptionsFromDataset', () => {
  it('returns undefined when every 3d field is at its default (legacy fast path)', () => {
    // The renderer's option-aware code path is only entered when
    // the dataset actually carries hints — keeps the common
    // (Earth, global, prime-meridian, no-flip) case on the
    // pre-3e fast path.
    expect(overlayOptionsFromDataset(makeDataset())).toBeUndefined()
  })

  it('returns undefined for an explicit-Earth dataset with no other hints', () => {
    expect(
      overlayOptionsFromDataset(makeDataset({ celestialBody: 'Earth' })),
    ).toBeUndefined()
    expect(
      overlayOptionsFromDataset(makeDataset({ celestialBody: '' })),
    ).toBeUndefined()
  })

  it('returns undefined when isFlippedInY is the documented default (false)', () => {
    expect(
      overlayOptionsFromDataset(makeDataset({ isFlippedInY: false })),
    ).toBeUndefined()
  })

  it('returns the bundle when boundingBox is set', () => {
    const bbox = { n: 52.621, s: 21.1381, w: -134.099, e: -60.9016 }
    const opts = overlayOptionsFromDataset(makeDataset({ boundingBox: bbox }))
    expect(opts).toEqual({
      boundingBox: bbox,
      lonOrigin: undefined,
      isFlippedInY: undefined,
      celestialBody: undefined,
      // Identity rides along with the geometry so a frame can say
      // which dataset it is without consulting app state.
      datasetId: 'DS_X',
      datasetTitle: 'Test',
    })
  })

  it('returns the bundle when lonOrigin is set (even to 0 — publisher intent matters)', () => {
    // Phase 3d's serializer preserves lonOrigin=0 explicitly when
    // the publisher set it; the loader carries that forward so a
    // round-trip read on the next reload sees the same value.
    expect(overlayOptionsFromDataset(makeDataset({ lonOrigin: 0 }))?.lonOrigin).toBe(0)
    expect(overlayOptionsFromDataset(makeDataset({ lonOrigin: 180 }))?.lonOrigin).toBe(180)
    expect(overlayOptionsFromDataset(makeDataset({ lonOrigin: -180 }))?.lonOrigin).toBe(-180)
  })

  it('returns the bundle when isFlippedInY is true', () => {
    expect(
      overlayOptionsFromDataset(makeDataset({ isFlippedInY: true })),
    ).toMatchObject({ isFlippedInY: true })
  })

  it('returns the bundle when celestialBody is non-Earth', () => {
    expect(
      overlayOptionsFromDataset(makeDataset({ celestialBody: 'Mars' })),
    ).toMatchObject({ celestialBody: 'Mars' })
  })

  it('returns the bundle when every field is populated (regional-non-Earth row)', () => {
    const bbox = { n: 60, s: -60, w: -120, e: 120 }
    const opts = overlayOptionsFromDataset(
      makeDataset({
        boundingBox: bbox,
        lonOrigin: 180,
        isFlippedInY: true,
        celestialBody: 'Mars',
      }),
    )
    expect(opts).toEqual({
      boundingBox: bbox,
      lonOrigin: 180,
      isFlippedInY: true,
      celestialBody: 'Mars',
      datasetId: 'DS_X',
      datasetTitle: 'Test',
    })
  })

  it('ignores non-finite lonOrigin values (defensive against bad catalog rows)', () => {
    // A future bad write that lands NaN / Infinity on the wire
    // shouldn't trip the renderer's option-aware path; treat as
    // "not set" so the legacy fast path stays in play.
    expect(
      overlayOptionsFromDataset(makeDataset({ lonOrigin: NaN as unknown as number })),
    ).toBeUndefined()
    expect(
      overlayOptionsFromDataset(makeDataset({ lonOrigin: Infinity as unknown as number })),
    ).toBeUndefined()
  })
})

describe('overlayOptionsFromDataset — data-encoded video', () => {
  const colorScale: ColorScale = {
    stops: [
      { t: 0, rgba: [0, 0, 0, 0] },
      { t: 1, rgba: [255, 0, 0, 255] },
    ],
    vmin: 0,
    vmax: 50,
    units: 'mg m-2',
  }

  it('carries the palette through when the dataset declares data-luma', () => {
    // This bundle is the only path the palette has to all four
    // render surfaces, so it has to survive on its own — with no
    // bbox, no lonOrigin, no flip, and an Earth body.
    const options = overlayOptionsFromDataset(
      makeDataset({ renderEncoding: 'data-luma', colorScale }),
    )
    expect(options?.colorScale).toEqual(colorScale)
  })

  it('alongside the Phase 3d fields, without disturbing them', () => {
    const options = overlayOptionsFromDataset(
      makeDataset({
        renderEncoding: 'data-luma',
        colorScale,
        lonOrigin: 180,
        isFlippedInY: true,
      }),
    )
    expect(options?.colorScale).toEqual(colorScale)
    expect(options?.lonOrigin).toBe(180)
    expect(options?.isFlippedInY).toBe(true)
  })

  // The backwards-compatibility guarantee, stated as a test: a
  // dataset that does not opt in must still take the pre-existing
  // `undefined` fast path, so every render surface runs exactly the
  // code it runs today.
  it('still returns undefined for a plain legacy dataset', () => {
    expect(overlayOptionsFromDataset(makeDataset())).toBeUndefined()
  })

  it('ignores a palette that is not paired with the encoding', () => {
    // A colorScale without renderEncoding is inert by contract; it
    // must not reach a shader and must not defeat the fast path.
    expect(overlayOptionsFromDataset(makeDataset({ colorScale }))).toBeUndefined()
  })

  it('ignores an encoding that arrives without a palette', () => {
    expect(
      overlayOptionsFromDataset(makeDataset({ renderEncoding: 'data-luma' }))?.colorScale,
    ).toBeUndefined()
  })
})
