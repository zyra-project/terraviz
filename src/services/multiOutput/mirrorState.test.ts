// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'

import type { Dataset } from '../../types'
import { overlayForMirror, toMirroredDataset } from './mirrorState'

/** The common case: a global, prime-meridian, unflipped Earth picture —
 *  the one `overlayOptionsFromDataset` deliberately returns `undefined`
 *  for, to keep the renderer on its fast path. */
function plainDataset(over: Partial<Dataset> = {}): Dataset {
  return { id: 'INTERNAL_plain', title: 'A Plain Picture', ...over } as Dataset
}

describe('overlayForMirror', () => {
  it('falls back to an identity-only bundle for a default-geometry dataset', () => {
    const overlay = overlayForMirror(plainDataset())

    // The wire format has no fast path, and the reason it doesn't is
    // these two fields: a frame must be able to say what it is without
    // asking app state.
    expect(overlay.datasetId).toBe('INTERNAL_plain')
    expect(overlay.datasetTitle).toBe('A Plain Picture')
    // Every geometric field stays absent — that is what the renderer's
    // `undefined` meant, and inventing a default here would be claiming
    // the catalog said something it did not.
    expect(overlay.boundingBox).toBeUndefined()
    expect(overlay.lonOrigin).toBeUndefined()
    expect(overlay.isFlippedInY).toBeUndefined()
    expect(overlay.colorScale).toBeUndefined()
  })

  it('passes a real bundle through, identity included', () => {
    const overlay = overlayForMirror(
      plainDataset({ id: 'INTERNAL_regional', lonOrigin: 20, isFlippedInY: true }),
    )

    expect(overlay.lonOrigin).toBe(20)
    expect(overlay.isFlippedInY).toBe(true)
    expect(overlay.datasetId).toBe('INTERNAL_regional')
  })
})

describe('toMirroredDataset', () => {
  it('carries the control-resolved URL and kind', () => {
    const mirrored = toMirroredDataset(plainDataset(), 'video', 'https://cdn/x.m3u8')

    expect(mirrored).toEqual({
      id: 'INTERNAL_plain',
      url: 'https://cdn/x.m3u8',
      kind: 'video',
      overlay: { datasetId: 'INTERNAL_plain', datasetTitle: 'A Plain Picture' },
    })
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
  ])('returns null when the URL is %s', (_label, url) => {
    // An output handed '' fetches its own document and tries to decode
    // the HTML as a texture — a failure that surfaces far from here.
    // `null` is already the schema's "nothing loaded".
    expect(toMirroredDataset(plainDataset(), 'image', url)).toBeNull()
  })
})
