// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The web output's camera: which place is at the centre of the picture,
 * how far it is magnified, and how the picture gets from one view to the
 * next (`docs/SECOND_LIFE_COMPAT.md` §9, Phase 4).
 *
 * **The desktop output's follow turn, not a second one.** A desktop
 * output that tracks its control globe brings the operator's centre to
 * the sphere's front, north up, and magnifies it there
 * (`equirectRtt.followCamera`). The address names a centre and a zoom,
 * and `viewParams` hands them to that same function, so a pole comes to
 * the centre of the picture with the sphere upright, and every check
 * already made of the follow turn on WebGL holds here too. Bearing is
 * left at 0: north is always up, the only way a controller has needed so
 * far. Adding it later is one more key.
 *
 * **The centre longitude is `rotation`'s.** With the centre on the
 * equator the follow turn is a turn about the poles, exactly what
 * `rotation` has always done, so the two would be one quantity under two
 * names. At a pole every longitude meets, and the same number then names
 * the meridian the centre sits on: it runs up the picture from the South
 * Pole and down it from the North Pole, as it does on the app's globe at
 * a bearing of 0. Stepping it turns the picture about the pole, which is
 * what turning a tipped globe on its axis does.
 *
 * **The address names where the picture comes to rest**, and the view
 * moves there like a heavy globe (the maintainer's decision, 25 October
 * 2026, recorded as a v1 behaviour change in the grammar). A Second Life
 * globe script can change its media address at most once a second, and a
 * picture that jumped 30° each time would read as a fault; one that
 * eased in and out reads as an animation. So each part of the view is a
 * mass on a bearing, given a short push toward its new place and left to
 * coast there (`stepView`): it moves on the first frame and is at full
 * speed after about 0.23 s, then slows like a spun globe on its bearing,
 * with the VR globe's flick constant (`VIEW_COAST_S`). Between the stops
 * below, the motion is the exact solution, so a copy drawing at 30 Hz and
 * one at 144 Hz are in the same place at the same moment; it never swings
 * past a target it set out for from rest; and a new target arriving
 * mid-coast adds to the motion rather than stopping it, so a press made
 * while the globe still turns pushes it on, and a view sent every second
 * reads as one movement. The stops (a crossed target, a pole, zero zoom,
 * arriving) are applied at frame boundaries, so copies can differ by up
 * to a frame there. Copies differ while they move, as they do after a
 * seek, then agree.
 *
 * **Every copy turns the same way.** Which way is the short way round is
 * decided between one address and the next, never from where each copy's
 * picture happens to be, which differs while they move: decided from the
 * picture, two copies near the antipode of a new view turned opposite
 * ways (found in review). The target is kept as the address's own number,
 * so the decision is made from two numbers every copy that applied the
 * same last address parsed from the same text; built up by arithmetic,
 * copies with different histories held targets a few units in the last
 * place apart and split on a half turn, which is what the exhibit's idle
 * return makes for about one home rotation in ten (found in review). A
 * half turn counts the longitude up, as `shortTurn` reads it, and that
 * holds for decimals too: its `+ 540` rounds `180.07 − 0.07` to 180.
 *
 * The view is set at once, with no motion, on the first reading of an
 * address (a copy opening mid-session shows what the others show, not a
 * fly-in) and for a viewer whose browser says they asked for reduced
 * motion.
 */

import { IDENTITY_PARAMS, followCamera, type EquirectParams } from './equirectRtt'

/** What the centre of the picture shows, and how magnified it is. */
export interface WebView {
  /** Degrees north, −90 to 90. */
  latDeg: number
  /** Degrees east. At a pole, the meridian the centre sits on. */
  lonDeg: number
  /** MapLibre's zoom levels, 0 to `MAX_CAMERA_ZOOM`. */
  zoom: number
}

/** The view a bare address shows: 0°N 0°E, unmagnified. */
export const DEFAULT_VIEW: WebView = { latDeg: 0, lonDeg: 0, zoom: 0 }

/**
 * The scene parameters that show `view`: the follow turn and camera
 * offset, with no rotation offset of their own, since the turn already
 * carries the longitude. The default view derives to `IDENTITY_PARAMS`
 * exactly (`followOrientation` folds its `−0`s for that reason).
 */
export function viewParams(view: WebView): EquirectParams {
  return { ...IDENTITY_PARAMS, ...followCamera(view.latDeg, view.lonDeg, view.zoom, 0) }
}

/**
 * How quickly the push gets the globe going, in seconds. Short, so a
 * press visibly answers at once; with the coast below, the globe moves on
 * the first frame and reaches full speed after about 0.23 s.
 */
export const VIEW_PUSH_S = 0.1

/**
 * How the globe slows, in seconds: its speed falls to 37% in this time,
 * then to 37% of that, and so on, as a spun globe's does on its bearing.
 * The value `vrInteraction`'s flick-to-spin uses (`INERTIA_TIME_CONSTANT`),
 * tuned there on a headset. Copied rather than imported, which would pull
 * Three into this page; a test holds the two equal.
 */
export const VIEW_COAST_S = 0.7

/** Close enough to stop: under a quarter of a pixel on the widest picture
 *  the page draws (8192 across 360°), and under a tenth on a Second Life
 *  face. Tighter only lengthens the tail spent drawing at the display
 *  rate for motion nobody can see. */
const SETTLED_DEG = 0.01
const SETTLED_ZOOM = 1e-3

/** A motion in progress: where it is, and how fast each part moves. */
export interface ViewMotion {
  view: WebView
  /** Per second, in each component's own units. */
  velocity: WebView
}

/** `deg` as the shortest signed turn, in (−180, 180]. */
function shortTurn(deg: number): number {
  const wrapped = (((deg % 360) + 540) % 360) - 180
  return wrapped === -180 ? 180 : wrapped
}

const PUSH = 1 / VIEW_PUSH_S
const COAST = 1 / VIEW_COAST_S

/**
 * One component, `dtS` seconds on. `offset` is the distance from the
 * target. The exact solution of `x″ + (p + c)x′ + pc·x = 0`, with the
 * push's rate `p` and the coast's `c`: overdamped, so from rest it closes
 * on the target without passing it, at full speed when `e^(−pt) · p`
 * meets `e^(−ct) · c` (about 0.23 s) and slowing over `VIEW_COAST_S`.
 */
function coastTowards(
  offset: number,
  velocity: number,
  dtS: number,
  settled: number,
): { offset: number; velocity: number } {
  const fast = -(velocity + COAST * offset) / (PUSH - COAST)
  const slow = (velocity + PUSH * offset) / (PUSH - COAST)
  const fastDecay = Math.exp(-PUSH * dtS)
  const slowDecay = Math.exp(-COAST * dtS)
  let next = fast * fastDecay + slow * slowDecay
  let nextVelocity = -PUSH * fast * fastDecay - COAST * slow * slowDecay
  // A target that moved against the motion can be passed once. Stop on
  // it instead of swinging back.
  if (next * offset < 0) {
    next = 0
    nextVelocity = 0
  }
  if (Math.abs(next) < settled && Math.abs(nextVelocity) * VIEW_COAST_S < settled) {
    next = 0
    nextVelocity = 0
  }
  return { offset: next, velocity: nextVelocity }
}

/**
 * `motion`, `dtS` seconds closer to `target`. Pure. Longitudes are taken
 * as they are, not round the turn: the way round is `createViewGlide`'s
 * to choose, once for every copy.
 */
export function stepView(motion: ViewMotion, target: WebView, dtS: number): ViewMotion {
  if (!(dtS > 0)) return motion
  const lat = coastTowards(motion.view.latDeg - target.latDeg, motion.velocity.latDeg, dtS, SETTLED_DEG)
  const lon = coastTowards(motion.view.lonDeg - target.lonDeg, motion.velocity.lonDeg, dtS, SETTLED_DEG)
  const zoom = coastTowards(motion.view.zoom - target.zoom, motion.velocity.zoom, dtS, SETTLED_ZOOM)
  let latDeg = target.latDeg + lat.offset
  let latVelocity = lat.velocity
  // Carried past a pole by a change of mind, the camera would turn upside
  // down; it stops on the pole instead.
  if (Math.abs(latDeg) > 90) {
    latDeg = Math.sign(latDeg) * 90
    latVelocity = 0
  }
  let zoomTo = target.zoom + zoom.offset
  let zoomVelocity = zoom.velocity
  if (zoomTo < 0) {
    zoomTo = 0
    zoomVelocity = 0
  }
  return {
    view: { latDeg, lonDeg: target.lonDeg + lon.offset, zoom: zoomTo },
    velocity: { latDeg: latVelocity, lonDeg: lon.velocity, zoom: zoomVelocity },
  }
}

const STILL: WebView = { latDeg: 0, lonDeg: 0, zoom: 0 }

/** Whether `motion` has arrived at `target` and stopped. */
export function isSettled(motion: ViewMotion, target: WebView): boolean {
  const v = motion.velocity
  return (
    motion.view.latDeg === target.latDeg &&
    motion.view.lonDeg === target.lonDeg &&
    motion.view.zoom === target.zoom &&
    v.latDeg === 0 &&
    v.lonDeg === 0 &&
    v.zoom === 0
  )
}

export interface ViewGlide {
  /** Where the picture is now. Its longitude may lie outside [0, 360). */
  view(): WebView
  /**
   * Head for `target`. `snap` sets the view there at once and stops any
   * motion, for a first reading or a viewer who asked for reduced motion.
   */
  aim(target: WebView, snap: boolean, nowMs: number): void
  /** Move on to `nowMs`. Whether the view changed, so the caller draws
   *  it; false once it has arrived, so a still picture costs nothing. */
  advance(nowMs: number): boolean
  /** Whether it is still on its way: drawn at the moving-content pace
   *  until it arrives. */
  moving(): boolean
}

export function createViewGlide(initial: WebView = DEFAULT_VIEW): ViewGlide {
  let motion: ViewMotion = { view: { ...initial }, velocity: STILL }
  let target: WebView = { ...initial }
  let lastMs: number | null = null

  /** The motion carried on to `nowMs` toward the target it had. One that
   *  has arrived is left as it is, so `advance` can tell it is still. */
  const catchUp = (nowMs: number): void => {
    if (lastMs !== null && !isSettled(motion, target)) motion = stepView(motion, target, (nowMs - lastMs) / 1000)
    lastMs = nowMs
  }

  return {
    view: () => motion.view,

    aim(next, snap, nowMs) {
      // Up to now toward the old target first, so a change of target
      // costs no motion, whatever the frame phase it lands on.
      catchUp(nowMs)
      // The short way round from the last address to this one: both are
      // numbers read from an address, so every copy that applied the same
      // last address decides alike.
      const turn = shortTurn(next.lonDeg - target.lonDeg)
      // The new target is the address's own number, which lies that turn
      // from the old target give or take whole turns, so the picture is
      // moved by those whole turns instead and nothing builds up. Rounded,
      // not floored: the quotient lands a hair either side of a whole
      // number, and floored, 0 then 0.01 shifted the picture a turn and
      // sent it 359.99° the wrong way (found in review).
      const turns = 360 * Math.round((target.lonDeg + turn - next.lonDeg) / 360)
      target = { ...next }
      motion = snap
        ? { view: { ...target }, velocity: STILL }
        : { view: { ...motion.view, lonDeg: motion.view.lonDeg - turns }, velocity: motion.velocity }
    },

    advance(nowMs) {
      const before = motion
      catchUp(nowMs)
      return motion !== before
    },

    moving: () => !isSettled(motion, target),
  }
}
