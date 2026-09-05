// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'

import { scenes, pointClearOfPanel } from './scenes'

describe('screenshot scene manifest', () => {
  it('covers the high-traffic surface (~15–30 scenes)', () => {
    expect(scenes.length).toBeGreaterThanOrEqual(15)
    expect(scenes.length).toBeLessThanOrEqual(40)
  })

  it('every scene has a unique name', () => {
    const names = scenes.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('names are filesystem- and Weblate-safe slugs', () => {
    // Used verbatim as `<name>.png` and as the Weblate screenshot
    // name, so keep them to lowercase / digits / dashes.
    for (const s of scenes) {
      expect(s.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    }
  })

  it('every scene has a non-empty description and a setup function', () => {
    for (const s of scenes) {
      expect(s.description.trim().length).toBeGreaterThan(0)
      expect(typeof s.setup).toBe('function')
    }
  })

  it('covers the publisher and admin surfaces', () => {
    const names = scenes.map((s) => s.name)
    expect(names).toEqual(expect.arrayContaining(['publish-datasets']))
    expect(names.some((n) => n.startsWith('admin-'))).toBe(true)
  })

  it('covers the alternate browse views and help', () => {
    const names = scenes.map((s) => s.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'browse-graph-view',
        'browse-timeline-view',
        'browse-map-view',
        'help-panel',
      ]),
    )
  })

  it('covers the globe-overlay surfaces', () => {
    const names = scenes.map((s) => s.name)
    expect(names).toEqual(
      expect.arrayContaining(['tools-menu', 'orbit-settings']),
    )
  })
})

describe('pointClearOfPanel', () => {
  // The two viewports the report captures, with the analyze panel at
  // its `max-block-size` of 34rem. Desktop keeps it in the bottom-right
  // corner; at ≤600px `analyze.css` swaps to `inset-inline`, so it
  // spans the full width — which is the whole bug this guards.
  const DESKTOP = { x: 0, y: 0, width: 1440, height: 900 }
  const DESKTOP_PANEL = { x: 1072, y: 340, width: 352, height: 544 }
  const MOBILE = { x: 0, y: 0, width: 390, height: 844 }
  const MOBILE_PANEL = { x: 12, y: 284, width: 366, height: 544 }

  const onPanel = (p: { x: number; y: number }, panel: typeof DESKTOP_PANEL) =>
    p.x >= panel.x && p.x <= panel.x + panel.width &&
    p.y >= panel.y && p.y <= panel.y + panel.height

  it('leaves a point that misses the panel exactly where it was', () => {
    // Desktop must be untouched, or every capture of a scene using this
    // shifts and reads as a visual regression that is really a no-op.
    // Asserted against the expression the callers used *before* this
    // helper existed, rather than against rounded literals: the point
    // is bit-for-bit equality with the old behaviour, and `0.56 * 900`
    // is 504.00000000000006 either way.
    const before = (b: typeof DESKTOP, fx: number, fy: number) => ({
      x: b.x + b.width * fx,
      y: b.y + b.height * fy,
    })
    expect(pointClearOfPanel(DESKTOP, DESKTOP_PANEL, 0.4, 0.38))
      .toEqual(before(DESKTOP, 0.4, 0.38))
    expect(pointClearOfPanel(DESKTOP, DESKTOP_PANEL, 0.6, 0.56))
      .toEqual(before(DESKTOP, 0.6, 0.56))
  })

  it('leaves a point that shares the panel\'s columns but sits above it', () => {
    // Regression: the first version tested x-overlap only, so a point
    // in the panel's columns was moved even when it was already well
    // above the panel's top edge. For a bottom-anchored panel that is
    // most of the canvas above it — (1296, 180) against a panel
    // starting at y=340 was being dragged up to y=68 for nothing.
    const p = pointClearOfPanel(DESKTOP, DESKTOP_PANEL, 0.9, 0.2)

    expect(onPanel(p, DESKTOP_PANEL)).toBe(false)
    expect(p).toEqual({ x: 1440 * 0.9, y: 900 * 0.2 })
  })

  it('lifts a point that would land on a full-width panel', () => {
    const a = pointClearOfPanel(MOBILE, MOBILE_PANEL, 0.4, 0.38)
    const b = pointClearOfPanel(MOBILE, MOBILE_PANEL, 0.6, 0.56)
    expect(onPanel(a, MOBILE_PANEL)).toBe(false)
    expect(onPanel(b, MOBILE_PANEL)).toBe(false)
    // Still two distinct points, still in the canvas, still ordered.
    expect(a.y).toBeLessThan(b.y)
    expect(a.y).toBeGreaterThanOrEqual(MOBILE.y)
  })

  it('is a no-op when there is no panel at all', () => {
    expect(pointClearOfPanel(MOBILE, null, 0.4, 0.38)).toEqual({ x: 390 * 0.4, y: 844 * 0.38 })
  })

  it('throws with a diagnosis rather than clicking somewhere useless', () => {
    // A panel covering all but a sliver. Clicking anyway would fail far
    // downstream as an unrelated timeout, which is exactly what made
    // the original bug take a week to find.
    const tall = { x: 0, y: 40, width: 390, height: 800 }
    expect(() => pointClearOfPanel(MOBILE, tall, 0.5, 0.5)).toThrow(/only 40px of canvas is clear/)
  })
})
