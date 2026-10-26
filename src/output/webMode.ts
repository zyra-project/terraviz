// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The output page's **web mode**: what to show, read from the page's
 * own address (`docs/SECOND_LIFE_COMPAT.md` §7; the grammar is in
 * `docs/EMBED_URL_GRAMMAR.md`).
 *
 * On desktop an output is told what to show by its control window. On
 * the web there is none — in Second Life every visitor's viewer runs
 * its own copy of the page — so the address is the one thing every copy
 * shares, and this module is the one reader of it.
 *
 * **Query and fragment are one set of parameters, and the fragment
 * wins.** A fixed setup can sit in the query. Whatever changes during a
 * session belongs after `#`, because a browser applies a `#`-only
 * change without reloading the page (whether Second Life's viewers pass
 * one on is §10 question 10 of that doc). Reading both halves the same
 * way lets a controller move any setting into the fragment without the
 * page caring which half it came from.
 *
 * **Every value fails closed, one at a time.** A malformed or unknown
 * value is ignored and that setting keeps its default — the grammar's
 * convention for the main app — so a typo costs one setting, never the
 * page. That includes the clock's four keys: each has its own default,
 * so `paused` without a `t` pauses at the start rather than being
 * dropped with it. Numbers are plain decimals, so `0x1000` and `4e3` are
 * not 4096 by accident of `Number()`.
 */

import {
  DEFAULT_FRAMEBUFFER_WIDTH,
  FRAMEBUFFER_WIDTHS,
  type FramebufferWidth,
} from '../services/multiOutput/protocol'
import { normalizeRotationOffset } from '../services/multiOutput/outputPersistence'
import { MAX_PLAYBACK_RATE, MIN_PLAYBACK_RATE, SYNC_MAX_RATE_TRIM } from '../utils/time'
import { MAX_CAMERA_ZOOM } from './equirectRtt'
import type { WebView } from './webCamera'

/**
 * Where the clip should be, shared by every copy of the page.
 *
 * A position and the moment it was current, not "the moment play was
 * pressed": without the position, resuming at 40 s and resuming at 70 s
 * would be the same address. Whoever controls the globe writes a new
 * anchor on every pause, resume and jump.
 */
export interface WebClock {
  /** Seconds into the clip. */
  positionS: number
  /**
   * Unix time, in seconds, at which `positionS` was current. `null`
   * means "when this copy read the address": at page load, or at the
   * `#` change that set this clock. That leaves each copy on its own
   * clock, fine for one viewer and not shared between several.
   */
  atUnixS: number | null
  /** Playback rate; 1 is the dataset's own speed. */
  rate: number
  /** Hold `positionS` exactly, rather than play from it. */
  paused: boolean
}

export interface WebOutputSettings {
  /** The node's dataset id, or `null` for the idle Earth. */
  datasetId: string | null
  /** `contain` letterboxes a non-2:1 page, which is right for a
   *  monitor; `fill` stretches to it, which is right for a texture. */
  fit: 'contain' | 'fill'
  /** A framebuffer rung, or `null` for the page to choose one from its
   *  own displayed size (`defaultWebFramebufferWidth`). */
  framebufferWidth: FramebufferWidth | null
  /** What the centre of the picture shows and how magnified it is: `lat`,
   *  `rotation` as the longitude (wrapped into [0, 360)) and `zoom`. The
   *  scene takes it through `webCamera.viewParams`, moving between
   *  views. */
  view: WebView
  /** Show the debug HUD. */
  debug: boolean
  /** Report the page's own telemetry (`webTelemetry.ts`). Off unless
   *  the address turns it on, and followed live like everything else. */
  telemetry: boolean
  /** Always a clock: a bare address plays from the start at the clip's
   *  own speed, from when this copy read it. */
  clock: WebClock
}

/** The rates a web clock will play: the player's own limits, less the
 *  room the control law's rate trim needs to catch up or fall back.
 *  Below the player's minimum the law clamps, the element outran its
 *  clock and was seeked back every few seconds; at the maximum the trim
 *  cannot speed up, so a copy a seek left behind stayed behind for good,
 *  by its own seek's cost (both found in review). 1/12 to 12.8. Anything
 *  outside reads as rate 1. */
export const MIN_WEB_RATE = MIN_PLAYBACK_RATE / (1 - SYNC_MAX_RATE_TRIM)
export const MAX_WEB_RATE = MAX_PLAYBACK_RATE / (1 + SYNC_MAX_RATE_TRIM)

/** The shape of a node dataset id. Anything else would reach the API as
 *  a path segment, so it is refused here rather than escaped there. */
const DATASET_ID = /^[A-Za-z0-9_-]{1,128}$/

/** Both halves of the address as one parameter set, the fragment's
 *  values replacing the query's. */
export function mergedParams(search: string, hash: string): URLSearchParams {
  const merged = new URLSearchParams(search)
  const fragment = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  for (const key of new Set(fragment.keys())) merged.set(key, fragment.get(key) ?? '')
  return merged
}

/** The grammar's boolean convention, exactly as `embedMode` reads it:
 *  present means on, and only `false` / `0` (any case, no trimming) mean
 *  off. */
function truthy(params: URLSearchParams, key: string): boolean {
  const raw = params.get(key)
  if (raw === null) return false
  const lowered = raw.toLowerCase()
  return lowered !== 'false' && lowered !== '0'
}

/**
 * Whether the address turns telemetry on: exactly `1` or `true` (any
 * case), and off for anything else or nothing.
 *
 * Off by default because the page loads for everyone in range of a
 * globe, who is shown no notice, and anyone can point a globe at a
 * public node. So only a globe whose owner chose to measure it reports
 * (the maintainer's decision, 24 October 2026). The usual boolean
 * reading would take `off`, `no` and an empty value as on, and a privacy
 * switch read that way does the opposite of what was written, so this
 * one fails toward off.
 */
function telemetryOn(params: URLSearchParams): boolean {
  const lowered = params.get('telemetry')?.toLowerCase()
  return lowered === '1' || lowered === 'true'
}

/** A plain decimal: digits, an optional point, an optional leading
 *  minus. No exponent, no hex, no padding. `Number()` alone would take
 *  `0x1000`, `4.096e3` and ` 4096` as 4096, and `''` as 0. */
const DECIMAL = /^-?(\d+(\.\d*)?|\.\d+)$/

/** A decimal number, or `null`. */
function decimal(params: URLSearchParams, key: string): number | null {
  const raw = params.get(key)
  if (raw === null || !DECIMAL.test(raw)) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

/** Each key on its own default, so one that is missing or malformed
 *  costs only itself. */
function readClock(params: URLSearchParams): WebClock {
  const t = decimal(params, 't')
  const at = decimal(params, 'at')
  const rate = decimal(params, 'rate')
  return {
    positionS: t !== null && t >= 0 ? t : 0,
    atUnixS: at !== null && at > 0 ? at : null,
    rate: rate !== null && rate >= MIN_WEB_RATE && rate <= MAX_WEB_RATE ? rate : 1,
    paused: truthy(params, 'paused'),
  }
}

/** Whether two clocks are the same instruction, so that a `#` change
 *  which moved only another setting does not restart a clock that has
 *  no `at`. */
export function sameClock(a: WebClock, b: WebClock): boolean {
  return a.positionS === b.positionS && a.atUnixS === b.atUnixS && a.rate === b.rate && a.paused === b.paused
}

/** Whether two views are the same instruction. */
export function sameView(a: WebView, b: WebView): boolean {
  return a.latDeg === b.latDeg && a.lonDeg === b.lonDeg && a.zoom === b.zoom
}

/**
 * The camera keys, each on its own default. `lat` outside ±90 and a
 * negative `zoom` mean nothing and read as the default. A zoom past the
 * most the projection can magnify is a zoom a globe could be at, so it
 * reads as that most, `MAX_CAMERA_ZOOM` (about 5.7). Kept as written, it
 * made a move between two zooms past it a second of drawing with nothing
 * changing, and a 308-digit one overflowed the motion to `NaN` for good
 * (found in review).
 */
function readView(params: URLSearchParams): WebView {
  const lat = decimal(params, 'lat')
  const rotation = decimal(params, 'rotation')
  const zoom = decimal(params, 'zoom')
  return {
    // `+ 0` folds a `-0`, so `lat=-0` reads as the default it is.
    latDeg: lat !== null && lat >= -90 && lat <= 90 ? lat + 0 : 0,
    lonDeg: normalizeRotationOffset(rotation ?? 0),
    zoom: zoom !== null && zoom >= 0 ? Math.min(zoom, MAX_CAMERA_ZOOM) + 0 : 0,
  }
}

/**
 * The framebuffer for a page whose address names none: the narrowest
 * rung at least as wide as the page is displayed, in device pixels, up
 * to the desktop default.
 *
 * A Second Life media face is at most 2048 wide and often 1024, and
 * drawing 4096 into it is four times the pixels anyone sees, on every
 * visitor's machine. The video cap follows the framebuffer, so this
 * also keeps a 1024 face off the 4096 stream. An unknown size takes the
 * desktop default, never more.
 */
export function defaultWebFramebufferWidth(displayWidthPx: number): FramebufferWidth {
  if (!(displayWidthPx > 0) || !Number.isFinite(displayWidthPx)) return DEFAULT_FRAMEBUFFER_WIDTH
  return FRAMEBUFFER_WIDTHS.find(w => w >= displayWidthPx && w <= DEFAULT_FRAMEBUFFER_WIDTH) ?? DEFAULT_FRAMEBUFFER_WIDTH
}

/** Everything the page shows, read from its address. */
export function readWebSettings(search: string, hash: string): WebOutputSettings {
  const params = mergedParams(search, hash)
  const dataset = params.get('dataset')
  const width = decimal(params, 'width')
  return {
    datasetId: dataset !== null && DATASET_ID.test(dataset) ? dataset : null,
    fit: params.get('fit') === 'fill' ? 'fill' : 'contain',
    framebufferWidth: (FRAMEBUFFER_WIDTHS as readonly number[]).includes(width ?? NaN)
      ? (width as FramebufferWidth)
      : null,
    view: readView(params),
    debug: truthy(params, 'debug'),
    telemetry: telemetryOn(params),
    clock: readClock(params),
  }
}
