// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VIEW,
  VIEW_COAST_S,
  createViewGlide,
  isSettled,
  stepView,
  viewParams,
  type ViewGlide,
  type ViewMotion,
  type WebView,
} from './webCamera'
import { IDENTITY_PARAMS, equirectSourceUv, followCamera } from './equirectRtt'

const STILL: WebView = { latDeg: 0, lonDeg: 0, zoom: 0 }
const FRAME_S = 1 / 60

/** `motion` stepped toward `target` in `frames` frames of `dtS`, every
 *  view on the way. */
function glide(motion: ViewMotion, target: WebView, dtS: number, frames: number): ViewMotion[] {
  const path: ViewMotion[] = []
  let m = motion
  for (let i = 0; i < frames; i++) path.push((m = stepView(m, target, dtS)))
  return path
}

const at = (latDeg: number, lonDeg = 0, zoom = 0): ViewMotion => ({ view: { latDeg, lonDeg, zoom }, velocity: STILL })

/** A view with only a longitude. */
const lon = (lonDeg: number): WebView => ({ latDeg: 0, lonDeg, zoom: 0 })

describe('viewParams', () => {
  it('derives the default view to the identity exactly', () => {
    expect(viewParams(DEFAULT_VIEW)).toEqual(IDENTITY_PARAMS)
  })

  it('is the desktop follow turn, north up', () => {
    const view = { latDeg: -72.5, lonDeg: 133, zoom: 1.5 }
    expect(viewParams(view)).toEqual({ ...IDENTITY_PARAMS, ...followCamera(-72.5, 133, 1.5, 0) })
  })

  it('draws an equator view exactly as the old rotation offset did', () => {
    // Every `rotation` address written before the camera existed shows the
    // same picture through the follow turn, in the shader's mirror.
    for (const l of [0, 30, 90, 137.5, 180, 270, 359]) {
      const old = { ...IDENTITY_PARAMS, rotationOffsetRad: (-l * Math.PI) / 180 }
      const now = viewParams(lon(l))
      for (const [u, v] of [[0.5, 0.5], [0.1, 0.3], [0.9, 0.8], [0.25, 0.05], [0.75, 0.97]]) {
        const a = equirectSourceUv(u, v, old)
        const b = equirectSourceUv(u, v, now)
        const du = ((((b.u - a.u) % 1) + 1.5) % 1) - 0.5
        expect(du).toBeCloseTo(0, 9)
        expect(b.v).toBeCloseTo(a.v, 9)
      }
    }
  })
})

describe('stepView: a heavy globe on a bearing', () => {
  it('pushes off at once, then coasts in, slowing like a spun globe on its bearing', () => {
    const path = glide(at(0, 0), lon(90), FRAME_S, 180)
    const speeds = path.map(m => m.velocity.lonDeg)
    // Moving on the first frame, and up to speed within a few tenths.
    expect(path[0].view.lonDeg).toBeGreaterThan(0)
    const peak = speeds.indexOf(Math.max(...speeds))
    expect(peak * FRAME_S).toBeLessThan(0.3)
    // Then what is left shrinks by the coast's own factor every second.
    const left = (i: number) => 90 - path[i].view.lonDeg
    expect(left(119) / left(59)).toBeCloseTo(Math.exp(-1 / VIEW_COAST_S), 3)
  })

  it('slows with the VR globe’s flick constant', () => {
    // Copied from `vrInteraction`, which would pull Three into the page.
    // The constant only: the VR spin also stops dead below about 57°/s,
    // where this has a target to land on.
    const vr = readFileSync(resolve(process.cwd(), 'src/services/vrInteraction.ts'), 'utf-8')
    const constant = String(VIEW_COAST_S).replace('.', '\\.')
    expect(vr).toMatch(new RegExp(`^const INERTIA_TIME_CONSTANT = ${constant}$`, 'm'))
  })

  it('never swings past a target it set out for from rest', () => {
    const path = glide(at(0), { latDeg: 30, lonDeg: 0, zoom: 3 }, FRAME_S, 600)
    for (let i = 1; i < path.length; i++) {
      expect(path[i].view.latDeg).toBeGreaterThanOrEqual(path[i - 1].view.latDeg)
      expect(path[i].view.latDeg).toBeLessThanOrEqual(30)
      expect(path[i].view.zoom).toBeLessThanOrEqual(3)
    }
  })

  it('stops on a target it would pass, rather than swinging back', () => {
    // Moving fast toward a target close by, after a change of target.
    const fast: ViewMotion = { view: lon(1), velocity: { latDeg: 0, lonDeg: -50, zoom: 0 } }
    const path = glide(fast, STILL, FRAME_S, 600)
    for (const m of path) expect(m.view.lonDeg).toBeGreaterThanOrEqual(0)
    expect(isSettled(path.at(-1)!, STILL)).toBe(true)
  })

  it('never carries the camera past a pole', () => {
    // Nearly on the South Pole and still moving toward it, when the
    // target goes back to 80°S: the motion carries on a little first.
    const going: ViewMotion = { view: { latDeg: -89, lonDeg: 0, zoom: 0 }, velocity: { latDeg: -40, lonDeg: 0, zoom: 0 } }
    const target = { latDeg: -80, lonDeg: 0, zoom: 0 }
    const path = glide(going, target, FRAME_S, 900)
    expect(Math.min(...path.map(m => m.view.latDeg))).toBe(-90)
    expect(path.at(-1)!.view).toEqual(target)
  })

  it('never takes the zoom below none', () => {
    // Moving fast away from a small zoom it was sent back to.
    const out: ViewMotion = { view: { latDeg: 0, lonDeg: 0, zoom: 0.2 }, velocity: { latDeg: 0, lonDeg: 0, zoom: -10 } }
    const target = { latDeg: 0, lonDeg: 0, zoom: 0.5 }
    const path = glide(out, target, FRAME_S, 900)
    expect(Math.min(...path.map(m => m.view.zoom))).toBe(0)
    expect(path.at(-1)!.view).toEqual(target)
  })

  it('arrives exactly, and then stays put', () => {
    const target = { latDeg: -45.5, lonDeg: 120, zoom: 2.25 }
    const path = glide(at(10, 300, 0), target, FRAME_S, 900)
    const last = path.at(-1)!
    expect(isSettled(last, target)).toBe(true)
    expect(last.view).toEqual(target)
    expect(stepView(last, target, FRAME_S)).toEqual(last)
  })

  it('follows one path whatever the frame rate', () => {
    // The exact motion, so a slow copy and a fast one are at the same
    // place at the same moment, not merely both on their way.
    const target = { latDeg: -60, lonDeg: 90, zoom: 2 }
    const sixty = glide(at(0), target, 1 / 60, 30).at(-1)!
    const thirty = glide(at(0), target, 1 / 30, 15).at(-1)!
    const once = stepView(at(0), target, 0.5)
    for (const m of [thirty, once]) {
      expect(m.view.latDeg).toBeCloseTo(sixty.view.latDeg, 9)
      expect(m.view.lonDeg).toBeCloseTo(sixty.view.lonDeg, 9)
      expect(m.view.zoom).toBeCloseTo(sixty.view.zoom, 9)
    }
  })

  it('does nothing for no time, or time running backwards', () => {
    const m = at(5)
    expect(stepView(m, STILL, 0)).toBe(m)
    expect(stepView(m, STILL, -1)).toBe(m)
  })
})

/** `g` advanced at 60 Hz from `fromMs` to `toMs`, the longitude at each
 *  frame. */
function run(g: ViewGlide, fromMs: number, toMs: number): number[] {
  const lons: number[] = []
  for (let t = fromMs; t <= toMs; t += 1000 / 60) {
    g.advance(t)
    lons.push(g.view().lonDeg)
  }
  return lons
}

describe('createViewGlide', () => {
  it('sets a snapped view at once and has nothing left to draw', () => {
    const g = createViewGlide()
    g.aim({ latDeg: -90, lonDeg: 45, zoom: 1 }, true, 0)
    expect(g.view()).toEqual({ latDeg: -90, lonDeg: 45, zoom: 1 })
    expect(g.advance(16)).toBe(false)
  })

  it('moves while it coasts and reports nothing once there', () => {
    const g = createViewGlide()
    g.aim(lon(30), false, 0)
    let t = 0
    expect(g.advance(t)).toBe(false)
    let moved = 0
    for (let i = 0; i < 900; i++) if (g.advance((t += 16))) moved++
    expect(moved).toBeGreaterThan(60)
    expect(g.view()).toEqual(lon(30))
    expect(g.advance((t += 16))).toBe(false)
  })

  it('turns the short way round', () => {
    const g = createViewGlide()
    g.aim(lon(350), true, 0)
    g.aim(lon(10), false, 0)
    // East from 350 through 0 to 10: 20° turned, never the 340° back
    // round through 180.
    const turned = (l: number): number => (((l - 350) % 360) + 360) % 360
    let last = 0
    for (const l of run(g, 0, 8000)) {
      expect(turned(l)).toBeGreaterThanOrEqual(last)
      expect(turned(l)).toBeLessThanOrEqual(20 + 1e-9)
      last = turned(l)
    }
    expect(g.view().lonDeg).toBe(10)
  })

  it('turns every copy the same way, whatever their pictures show', () => {
    // One copy opened on 60°E. Another was turning there from 90°E and
    // is a hair short of it. Then 240°E, half a turn away, arrives: chosen
    // from each picture, the two went opposite ways (found in review).
    const opened = createViewGlide()
    opened.aim(lon(60), true, 0)
    const turning = createViewGlide()
    turning.aim(lon(90), true, 0)
    turning.aim(lon(60), false, 0)
    let t = 0
    while (turning.view().lonDeg - 60 > 0.09) turning.advance((t += 1000 / 60))
    opened.advance(t)
    opened.aim(lon(240), false, t)
    turning.aim(lon(240), false, t)
    // Both east, round through 150 rather than through 330.
    const a = run(opened, t, t + 8000)
    const b = run(turning, t, t + 8000)
    expect(a[30]).toBeGreaterThan(70)
    expect(b[30]).toBeGreaterThan(70)
    for (const l of [...a, ...b]) {
      expect(l).toBeGreaterThan(59)
      expect(l).toBeLessThan(241)
    }
    expect(opened.view()).toEqual(turning.view())
  })

  it('turns copies with different histories the same way on a half turn', () => {
    // The exhibit's own pattern: an owner's home of 0.07°, six presses of
    // Turn east 30° apart, then the idle return home, half a turn away.
    // One copy followed every press; another opened after the last. Built
    // up by arithmetic, their targets differed in the last place and they
    // spun opposite ways for one home in ten (found in review).
    const followed = createViewGlide()
    followed.aim(lon(0.07), true, 0)
    let t = 0
    for (const r of [330.07, 300.07, 270.07, 240.07, 210.07, 180.07]) {
      t += 1000
      followed.aim(lon(r), false, t)
    }
    const late = createViewGlide()
    late.aim(lon(180.07), true, t)
    t += 1000
    followed.aim(lon(0.07), false, t)
    late.aim(lon(0.07), false, t)
    // A half turn counts the longitude up: from 180.07 through 270 to 360.07.
    const up = (l: number): number => (((l - 180.07) % 360) + 360) % 360
    const a = run(followed, t, t + 10_000)
    const b = run(late, t, t + 10_000)
    expect(up(a[180])).toBeGreaterThan(90)
    expect(up(b[180])).toBeGreaterThan(90)
    for (const l of b) expect(up(l)).toBeLessThanOrEqual(180 + 1e-9)
    expect(followed.view()).toEqual(late.view())
    expect(followed.view().lonDeg).toBe(0.07)
  })

  it('turns the short way on a tiny step, either side of the turn', () => {
    // The whole turns the picture is moved by are rounded, not floored:
    // floored, 0 then 0.01 moved it a turn and turned it 359.99° the wrong
    // way (found in review).
    for (const [from, to] of [[0, 0.01], [0.01, 0], [359.99, 0], [0, 359.99], [180, 180.01], [359.9, 0.1]]) {
      const g = createViewGlide()
      g.aim(lon(from), true, 0)
      g.aim(lon(to), false, 0)
      for (const l of run(g, 0, 8000)) {
        const apart = Math.abs(((((l - from) % 360) + 540) % 360) - 180)
        expect(apart, `${from} to ${to}`).toBeLessThan(1)
      }
      expect(g.view().lonDeg, `${from} to ${to}`).toBe(to)
    }
  })

  it('counts a half turn up, decimals included', () => {
    // `180.07 − 0.07` is not quite 180 in floating point; `shortTurn`'s
    // wrap rounds it to 180, which counts up.
    for (const [from, to] of [[0.07, 180.07], [180.07, 0.07], [10.1, 190.1], [359.9, 179.9]]) {
      const g = createViewGlide()
      g.aim(lon(from), true, 0)
      g.aim(lon(to), false, 0)
      g.advance(500)
      const turned = (((g.view().lonDeg - from) % 360) + 360) % 360
      expect(turned, `${from} to ${to}`).toBeGreaterThan(0)
      expect(turned, `${from} to ${to}`).toBeLessThan(180)
    }
  })

  it('says it is moving until it arrives', () => {
    const g = createViewGlide()
    expect(g.moving()).toBe(false)
    g.aim(lon(30), false, 0)
    expect(g.moving()).toBe(true)
    run(g, 0, 10_000)
    expect(g.moving()).toBe(false)
    g.aim(lon(60), true, 10_000)
    expect(g.moving()).toBe(false)
  })

  it('times a motion from when it was asked for, after a still minute', () => {
    const g = createViewGlide()
    expect(g.advance(0)).toBe(false)
    g.aim({ latDeg: -90, lonDeg: 0, zoom: 0 }, false, 60_000)
    g.advance(60_016)
    expect(g.view().latDeg).toBeGreaterThan(-10)
  })

  it('follows one path whatever falls between its frames', () => {
    // A new target lands between frames on one copy and on a frame on
    // another; the motion up to it is not lost on either.
    const a = createViewGlide()
    const b = createViewGlide()
    for (const g of [a, b]) g.aim(lon(60), false, 0)
    for (let t = 16; t < 500; t += 16) a.advance(t)
    for (let t = 33; t < 500; t += 33) b.advance(t)
    for (const g of [a, b]) g.aim({ latDeg: -40, lonDeg: 10, zoom: 1 }, false, 500)
    for (let t = 516; t < 1000; t += 16) a.advance(t)
    for (let t = 533; t < 1000; t += 33) b.advance(t)
    a.advance(1000)
    b.advance(1000)
    expect(b.view().latDeg).toBeCloseTo(a.view().latDeg, 9)
    expect(b.view().lonDeg).toBeCloseTo(a.view().lonDeg, 9)
    expect(b.view().zoom).toBeCloseTo(a.view().zoom, 9)
  })

  it('pushes on a globe still turning, so a view every second reads as one movement', () => {
    // A controller turning it 30° a second, once a second. Measured in the
    // fifth second, the speed should neither stall nor surge.
    const g = createViewGlide()
    g.aim(lon(0), true, 0)
    const lons: number[] = []
    for (let s = 1; s <= 5; s++) {
      g.aim(lon(30 * s), false, (s - 1) * 1000)
      lons.push(...run(g, (s - 1) * 1000 + 1000 / 60, s * 1000 - 1))
    }
    const last = lons.slice(-59)
    const speeds = last.slice(1).map((l, i) => (l - last[i]) * 60)
    const slowest = Math.min(...speeds)
    const fastest = Math.max(...speeds)
    expect(slowest).toBeGreaterThan(10)
    expect(fastest / slowest).toBeLessThan(3)
  })

  it('takes seconds to settle, not frames, and then settles', () => {
    const g = createViewGlide()
    const target = { latDeg: -90, lonDeg: 180, zoom: 5 }
    g.aim(target, false, 0)
    let t = 0
    let movingAt1500 = false
    while (g.advance((t += 16)) && t < 20_000) if (t >= 1500 && t < 1516) movingAt1500 = true
    expect(movingAt1500).toBe(true)
    expect(t).toBeLessThan(10_000)
    expect(g.view()).toEqual(target)
  })
})
