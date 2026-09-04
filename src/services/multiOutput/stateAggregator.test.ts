// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the mirrored-state accumulator.
 *
 * Three properties carry the contract with the output window, and each
 * one fails silently on a real sphere if it breaks: a diff must name
 * only what changed (an output rebuilds its HLS instance on `dataset`),
 * `seq` must never go backwards or repeat (the output coalesces
 * most-recent-wins, so a repeat lets a stale message win), and the
 * per-output view projection must not turn an absent key into a
 * present one.
 */

import { describe, it, expect } from 'vitest'
import type {
  MirroredDataset,
  MirroredGlobeState,
  MirroredLayer,
} from './protocol'
import { isFullState } from './protocol'
import {
  CENTRED_CAMERA,
  DEFAULT_VIEW_SETTINGS,
  StateAggregator,
  initialState,
  projectState,
  projectView,
} from './stateAggregator'

const DATASET: MirroredDataset = {
  id: 'ds-1',
  url: 'https://example.test/a.m3u8',
  kind: 'video',
  overlay: { datasetId: 'ds-1', boundingBox: { n: 50, s: 24, w: -125, e: -66 } },
}

const LAYER: MirroredLayer = {
  id: 'l-1',
  datasetId: 'ds-2',
  url: 'https://example.test/b.png',
  kind: 'image',
  overlay: { datasetId: 'ds-2' },
}

describe('initial state', () => {
  it('is a fresh object each call, so one aggregator cannot alias another', () => {
    const a = initialState()
    const b = initialState()
    expect(a).not.toBe(b)
    expect(a.view.cameraOffset).not.toBe(b.view.cameraOffset)
    expect(a).toEqual(b)
  })

  it('starts centred, empty and day/night on', () => {
    const s = initialState()
    expect(s.dataset).toBeNull()
    expect(s.playback).toBeNull()
    expect(s.layers).toEqual([])
    expect(s.view.dayNight).toBe(true)
    expect(s.view.cameraOffset).toEqual(CENTRED_CAMERA)
  })
})

describe('apply', () => {
  it('returns null when nothing changed, so the tick is free on a paused globe', () => {
    const agg = new StateAggregator()
    expect(agg.apply({})).toBeNull()
    expect(agg.apply({ dataset: null })).toBeNull()
    expect(agg.apply({ layers: [] })).toBeNull()
    expect(agg.sequence()).toBe(0)
  })

  it('names only the keys that changed', () => {
    const agg = new StateAggregator()
    agg.apply({ dataset: DATASET, simulationDate: '2026-01-01T00:00:00Z' })

    const msg = agg.apply({
      dataset: DATASET,
      simulationDate: '2026-01-02T00:00:00Z',
    })

    expect(msg).not.toBeNull()
    expect(Object.keys(msg!.state)).toEqual(['simulationDate'])
    expect(msg!.full).toBe(false)
  })

  it('drops a structurally identical value rather than re-broadcasting it', () => {
    const agg = new StateAggregator()
    agg.apply({ dataset: DATASET })

    // A fresh object with the same contents — what a call site that
    // rebuilds its options bundle every load actually produces.
    const rebuilt: MirroredDataset = {
      id: 'ds-1',
      url: 'https://example.test/a.m3u8',
      kind: 'video',
      overlay: { datasetId: 'ds-1', boundingBox: { n: 50, s: 24, w: -125, e: -66 } },
    }
    expect(agg.apply({ dataset: rebuilt })).toBeNull()
  })

  it('compares regardless of key order', () => {
    const agg = new StateAggregator()
    agg.apply({ view: { dayNight: true, cameraOffset: { x: 1, y: 2, z: 3 }, split: false } })
    const reordered = { split: false, cameraOffset: { z: 3, y: 2, x: 1 }, dayNight: true }
    expect(agg.apply({ view: reordered })).toBeNull()
  })

  it('ignores an explicitly-undefined key rather than clearing it', () => {
    const agg = new StateAggregator()
    agg.apply({ dataset: DATASET })
    // `{ dataset: undefined }` is what a spread of an optional field
    // produces. It must not be read as "clear the dataset" — the
    // schema spells absence as `null` — and it must not go on the
    // wire, since structured clone drops an `undefined` property and
    // the output would receive a diff naming a key that is not there.
    expect(agg.apply({ dataset: undefined })).toBeNull()
    expect(agg.current().dataset).toEqual(DATASET)
    expect(agg.sequence()).toBe(1)
  })

  it('detects a layer reorder, since array order is z-order', () => {
    const agg = new StateAggregator()
    const second: MirroredLayer = { ...LAYER, id: 'l-2', datasetId: 'ds-3' }
    agg.apply({ layers: [LAYER, second] })
    const msg = agg.apply({ layers: [second, LAYER] })
    expect(msg).not.toBeNull()
    expect((msg!.state as MirroredGlobeState).layers.map(l => l.id)).toEqual(['l-2', 'l-1'])
  })

  it('detects a change nested inside overlay', () => {
    const agg = new StateAggregator()
    agg.apply({ dataset: DATASET })
    const shifted: MirroredDataset = {
      ...DATASET,
      overlay: { ...DATASET.overlay, lonOrigin: 180 },
    }
    expect(agg.apply({ dataset: shifted })).not.toBeNull()
  })

  it('detects a null → value transition and back', () => {
    const agg = new StateAggregator()
    expect(agg.apply({ playback: { date: '2026-01-01T00:00:00Z', paused: false, playbackRate: 1 } })).not.toBeNull()
    expect(agg.apply({ playback: null })).not.toBeNull()
    expect(agg.apply({ playback: null })).toBeNull()
  })
})

describe('sequence numbers', () => {
  it('advances by one per real change and never for a no-op', () => {
    const agg = new StateAggregator()
    expect(agg.apply({ dataset: DATASET })!.seq).toBe(1)
    expect(agg.apply({})).toBeNull()
    expect(agg.apply({ simulationDate: '2026-03-01T00:00:00Z' })!.seq).toBe(2)
  })

  it('does not advance for full(), so a late joiner cannot out-rank a diff', () => {
    const agg = new StateAggregator()
    const diff = agg.apply({ dataset: DATASET })!
    const snap = agg.full()

    expect(snap.seq).toBe(diff.seq)
    expect(isFullState(snap)).toBe(true)
    // And the next real change still moves past both.
    expect(agg.apply({ simulationDate: '2026-03-01T00:00:00Z' })!.seq).toBe(diff.seq + 1)
  })

  it('full() carries the whole state, not just what changed', () => {
    const agg = new StateAggregator()
    agg.apply({ dataset: DATASET })
    const snap = agg.full()
    expect(isFullState(snap)).toBe(true)
    expect(snap.state).toEqual(agg.current())
    expect((snap.state as MirroredGlobeState).layers).toEqual([])
  })

  it('reset() returns to the initial state and restarts the sequence', () => {
    const agg = new StateAggregator()
    agg.apply({ dataset: DATASET })
    agg.reset()
    expect(agg.sequence()).toBe(0)
    expect(agg.current()).toEqual(initialState())
    expect(agg.apply({ dataset: DATASET })!.seq).toBe(1)
  })
})

describe('per-output view projection', () => {
  const shared = {
    dayNight: false,
    cameraOffset: { x: 0.4, y: -0.2, z: 0.1 },
    split: false,
  }

  it('passes the operator camera through when tracking', () => {
    const v = projectView(shared, { trackCamera: true, split: false })
    expect(v.cameraOffset).toEqual(shared.cameraOffset)
    expect(v.dayNight).toBe(false)
  })

  it('centres the camera when not tracking', () => {
    const v = projectView(shared, { trackCamera: false, split: false })
    expect(v.cameraOffset).toEqual(CENTRED_CAMERA)
  })

  it('takes split from the output, never from the shared view', () => {
    expect(projectView(shared, { trackCamera: true, split: true }).split).toBe(true)
    expect(projectView({ ...shared, split: true }, DEFAULT_VIEW_SETTINGS).split).toBe(false)
  })

  it('does not alias the shared offset, so one output cannot mutate another', () => {
    const v = projectView(shared, { trackCamera: true, split: false })
    expect(v.cameraOffset).not.toBe(shared.cameraOffset)
  })

  it('leaves a diff without a view untouched', () => {
    const diff = { simulationDate: '2026-01-01T00:00:00Z' }
    const projected = projectState(diff, { trackCamera: false, split: true })
    expect(projected).toBe(diff)
    expect('view' in projected).toBe(false)
  })

  it('projects a diff that does carry a view', () => {
    const diff = { view: shared }
    const projected = projectState(diff, { trackCamera: false, split: true })
    expect(projected.view.cameraOffset).toEqual(CENTRED_CAMERA)
    expect(projected.view.split).toBe(true)
    // The input is not mutated — two outputs project the same diff.
    expect(diff.view.cameraOffset).toEqual({ x: 0.4, y: -0.2, z: 0.1 })
  })
})
