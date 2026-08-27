// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Isolines over a data-encoded frame — the A5 half of
 * `docs/DATA_ANALYSIS_PLAN.md`.
 *
 * `datasetStats` answers "how much is above this line" as a single
 * number. This answers "and *where* are those lines", by marching
 * squares over the luma array at a set of physical levels, producing
 * lat/lon polylines a map can draw.
 *
 * A contour map is a *set* of lines, not one. The levels are chosen by
 * the caller — the Analyze panel passes the colour bar's own round-number
 * ticks, so every line on the globe corresponds to a labelled tick on the
 * bar and reading one against the other needs no interpolation.
 *
 * Pure, like every other reducer here: a `LumaSnapshot` in, geometry
 * out, no GL context and no MapLibre. See `datasetStats.ts` for why that
 * matters — the arithmetic that is easiest to get quietly wrong is the
 * arithmetic that has to be testable on its own.
 *
 * Five things this module is careful about:
 *
 *  1. **Absent data breaks the cell, it does not bound it.** A texel the
 *     sidecar calls "nothing measured here" is not a low value, and a
 *     cell touching one emits no segment at any level. Skip this and the
 *     contours trace the coastline of the no-data region as though it
 *     were a real gradient — a confident, beautifully smooth, entirely
 *     fictional isoline. This is the same mistake `datasetStats` refuses
 *     to make when it excludes absent texels from the mean rather than
 *     counting them as `vmin`.
 *  2. **Values come from `lumaToValue`, never from an inverse of it.**
 *     Levels are not converted into luma codes; instead a 256-entry
 *     table is built *through* `lumaToValue` and every comparison happens
 *     in physical units. A separate value→luma inverse would be a second
 *     copy of the mapping that has to be kept in step with the first one
 *     forever, in a different file, and the day it drifts the contour and
 *     the readout disagree while both look right.
 *  3. **One pass over the cells, not one pass per level.** The shipped
 *     frames are around 8.4 million texels. Re-walking that per level
 *     would put a visible stall between pressing the button and seeing
 *     lines, and the cost would grow with the number of levels rather
 *     than staying near the cost of one. Corner reads, the absent-data
 *     test and the cell's own min/max happen once; each level then costs
 *     a comparison against that range and, for the few cells it actually
 *     crosses, a marching-squares case.
 *
 *     This is a *user-initiated* pass, and it is not cheap even so.
 *     Measured on a synthetic 4096x2048 field with four plume-shaped
 *     blobs, twelve levels: **1595 ms** as first written, **376 ms** now,
 *     for byte-identical output. Almost all of that came from two places
 *     that looked free — five closures allocated on every emitting cell,
 *     and `h${x},${y}` string edge keys built and hashed once per
 *     crossing. Nine tenths of the time was in emitting segments rather
 *     than in walking 8.4 million cells, which is the opposite of where
 *     it looks like it should be. Measure before optimising this file.
 *
 *     The number that matters downstream: even at 376 ms this is about
 *     2.7 extractions per second against 30 fps playback, so contours
 *     cannot track a playing video and the Analyze panel drops them when
 *     the frame moves rather than pretending they are still current.
 *  5. **The output is bounded by what can be drawn, not by what can be
 *     traced.** Everything above tunes the cost of *one* cell. It says
 *     nothing about how many cells there are, or how many of them emit,
 *     and both assumptions broke on real data at once.
 *
 *     A plume field is a handful of connected regions with long smooth
 *     boundaries. A convective reflectivity field is thousands of
 *     discrete storm cells a few texels across, and marching squares
 *     traces a faithful closed ring around every one. Measured at
 *     7200x3600, six levels: **424,855 lines averaging 8.0 points
 *     each** — against **117 lines averaging 744** for a smoke field of
 *     the same size and *higher* coverage. Cost follows the number of
 *     boundaries, and a thousand small cells have far more boundary
 *     than one large one.
 *
 *     Eight points is a ring two or three texels wide: real data, and
 *     smaller than the stroke that would draw it at any zoom this app
 *     offers. So the frame is box-averaged down to `CONTOUR_TARGET_EDGE`
 *     before it is walked, and runs below `MIN_RING_EXTENT_FRACTION` of
 *     the frame are dropped: **2,713 lines**, the mean rising to 10.6
 *     points — fewer lines, each of them more line. On one machine, both
 *     ends measured back to back, **12.8 s to 0.37 s**; at 24 levels,
 *     39.3 s to 1.1 s.
 *
 *     Quote those two together or neither. An earlier draft of this
 *     comment paired a "before" taken while the machine was busy with an
 *     "after" taken while it was idle, and reported a ratio a third too
 *     flattering. The line counts are the load-independent half and were
 *     right all along.
 *
 *     Both bounds are set by the *display*, which is what makes them
 *     safe. Nothing here changes a reported value: `datasetStats` reduces
 *     the full-resolution snapshot and is untouched, so the panel's
 *     numbers stay exact while its lines move by up to half a decimated
 *     texel. If those two ever pull apart, the statistics win.
 *  4. **The antimeridian splits a line rather than crossing it.** A
 *     polyline whose longitudes jump from +179 to −179 is drawn by
 *     MapLibre as a stripe straight back across the globe. Lines are cut
 *     where they wrap.
 *
 * What this does **not** claim: the polygons enclosed by these lines are
 * not where the area figures come from. `areaAboveKm2` counts whole
 * texels by their own spherical cell area; an isoline is interpolated
 * between texel centres. They agree to within about one texel around the
 * perimeter, and the counted area is the one to quote, because it does
 * not depend on how the interpolation resolved an ambiguous cell.
 */

import type { DatasetOverlayOptions } from '../types'
import { isTransparentLuma, lumaToValue, type ColorScale } from '../types/color-scale'
import { texelUvToLatLon } from './datasetProbe'
import { fullWindow, LUMA_LEVELS, type TexelWindow } from './datasetStats'
import type { LumaSnapshot } from './glLumaSampler'

export interface ContourPoint {
  lat: number
  lon: number
}

/** One isoline, in order. Open at the frame's edge, closed (first point
 *  repeated last) where it encircles a region. */
export type ContourLine = ContourPoint[]

/** Every isoline at one physical level. */
export interface ContourLevel {
  /** The physical value these lines trace. */
  value: number
  lines: ContourLine[]
  /**
   * CSS colour for this level, set by the caller from the same display
   * LUT the shader samples so a line matches the palette at its own
   * value. Absent when the caller does not care — the geometry is
   * complete without it.
   */
  color?: string
}

/**
 * Most levels a single extraction will trace.
 *
 * Not a performance guard — the single pass handles more without much
 * extra cost — but a legibility one. Past about a dozen lines over a
 * smoke plume the globe reads as hatching rather than as structure, and
 * a caller asking for hundreds has almost certainly computed its levels
 * wrong.
 */
export const MAX_CONTOUR_LEVELS = 24

/**
 * Longitude jump beyond which a step is treated as a seam wrap rather
 * than real movement.
 *
 * Contour vertices are at most one texel apart, and no shipped dataset
 * has texels remotely this wide, so anything bigger is the ±180
 * discontinuity rather than a genuine stride.
 */
const SEAM_JUMP_DEGREES = 180

/** Per-luma-code physical values and absence flags, built once per
 *  extraction so the inner loop is two array reads. */
interface CodeTable {
  value: Float64Array
  absent: Uint8Array
  /**
   * Lowest code that is *not* absent, when absence is a contiguous band
   * at the bottom of the range. Both sidecar forms produce exactly that
   * — `luma < dataMinLuma` and `luma / 255 < transparentRange` are both
   * "below a cutoff" — which lets the cell walk decide rule 1 from its
   * lowest corner alone instead of testing all four.
   */
  absentBelow: number
  /**
   * Every absent code is below `absentBelow` — i.e. absence really is
   * the contiguous low band that field assumes.
   *
   * Separate from `monotone` because decimation needs exactly this and
   * not the ordering half: averaging codes is sound on an inverted ramp
   * (the mapping is still affine), but it is *not* sound if a present
   * code can sit below an absent one, because then neither "skip what
   * is absent" nor "write 0 to mean absent" is true.
   *
   * With today's sidecar this is always true, and deliberately still
   * computed: `isTransparentLuma` is "below a cutoff" in both its forms,
   * so no expressible scale can falsify it and the fallback below is
   * unreachable. It is here for the day a sentinel in the middle of the
   * range means "no data", when averaging across the gap would invent
   * values nobody measured. `datasetContours.test.ts` pins the contract
   * so that day fails a test rather than shipping.
   */
  absentIsLowBand: boolean
  /**
   * Absence is that low band *and* values rise with the code, so a
   * cell's value range can be read off its code range. False sends the
   * walk down the general path: the fast tests are an optimisation, not
   * a new contract, and a table shaped differently than expected must
   * come out with the same lines rather than with quietly wrong ones.
   */
  monotone: boolean
}

function buildCodeTable(scale: ColorScale): CodeTable {
  const value = new Float64Array(LUMA_LEVELS)
  const absent = new Uint8Array(LUMA_LEVELS)
  for (let luma = 0; luma < LUMA_LEVELS; luma++) {
    value[luma] = lumaToValue(luma, scale)
    absent[luma] = isTransparentLuma(luma, scale) ? 1 : 0
  }

  // Verified, not assumed. The fast path tests only the lowest corner
  // for absence, so a table with an absent code *above* a present one
  // would let absent texels into the contours — the rule-1 mistake, back
  // by a side door. 256 iterations to rule it out is free.
  let absentBelow = 0
  while (absentBelow < LUMA_LEVELS && absent[absentBelow] === 1) absentBelow++
  let absentIsLowBand = true
  for (let luma = absentBelow; luma < LUMA_LEVELS; luma++) {
    if (absent[luma] === 1) { absentIsLowBand = false; break }
  }
  let monotone = absentIsLowBand
  // `lumaToValue` is affine and increasing for vmax > vmin, but an
  // inverted scale is expressible and would flip which corner is the
  // cell minimum. Read the direction off the table rather than trusting
  // the arithmetic upstream.
  if (monotone) {
    for (let luma = 1; luma < LUMA_LEVELS; luma++) {
      if (value[luma] < value[luma - 1]) { monotone = false; break }
    }
  }

  return { value, absent, absentBelow, absentIsLowBand, monotone }
}

/**
 * Longest edge the cell walk runs at.
 *
 * A frame arriving above this is box-averaged down before it is
 * marched. The number is a *display* bound rather than a performance
 * one, which is why it is a fixed edge length and not a cell budget:
 * the globe never occupies more than a couple of thousand pixels
 * across, so an isoline resolved finer than this cannot be drawn
 * distinctly at any camera the app offers. Everything below that limit
 * is detail nobody can see, paid for at full price.
 *
 * It happens to be the difference between the panel working and the
 * panel locking the tab, on a 7200x3600 reflectivity frame: 16.8 s to
 * 0.6 s at six levels. But if the display bound and the performance
 * bound ever disagree, this one follows the display.
 */
export const CONTOUR_TARGET_EDGE = 2048

/**
 * How much of the frame a line must span, in its longer axis, to be
 * worth emitting — as a fraction of the frame's smaller dimension.
 *
 * The speckle problem in one number. A convective field is thousands of
 * discrete storm cells a few texels across, and marching squares
 * faithfully traces a closed ring around every one of them: measured on
 * a 7200x3600 reflectivity frame at six levels, 424,855 separate lines
 * averaging **8 points each**. Eight points is a ring two or three
 * texels wide. It is a real feature of the data and it is also, at
 * every zoom this app has, comfortably smaller than the stroke used to
 * draw it — so it arrives as a dot of noise, having cost a full share
 * of the extraction and of MapLibre's tessellation.
 *
 * Expressed as a fraction rather than a point count so it means the
 * same thing at every frame size. A count would be a different policy
 * on a 256-wide test frame than on a 7200-wide one, and the small end
 * is where it would quietly delete everything.
 *
 * Deliberately measured as *extent*, not perimeter or point count: a
 * long thin filament is a real feature with few points and a large
 * extent, and would be the first casualty of a perimeter rule.
 */
export const MIN_RING_EXTENT_FRACTION = 0.004

/**
 * The factor to walk a frame of `width` x `height` down by.
 *
 * Only strides that divide *both* dimensions exactly are considered.
 * The decimated grid has to cover the same geographic extent as the
 * original, because `assemble` maps texel coordinates to lat/lon
 * through a normalised UV and has no idea decimation happened. A stride
 * leaving a partial column at the edge would shrink the covered extent
 * while the UV mapping kept assuming the full one — every contour on
 * the frame stretched slightly east, from a rounding decision.
 *
 * The search gives up at twice the ideal stride rather than accepting
 * any divisor: a frame whose dimensions factor awkwardly is better
 * walked at full resolution than quartered again to suit the
 * arithmetic. Returning 1 is always correct, just slower.
 */
export function chooseStride(
  width: number,
  height: number,
  targetEdge: number = CONTOUR_TARGET_EDGE,
): number {
  const longest = Math.max(width, height)
  if (!(targetEdge > 0) || longest <= targetEdge) return 1
  const ideal = Math.ceil(longest / targetEdge)
  for (let s = ideal; s <= ideal * 2; s++) {
    if (width % s === 0 && height % s === 0) return s
  }
  return 1
}

/**
 * Box-average a frame down by `stride`, in luma.
 *
 * Averaging codes rather than values is exact here, not an
 * approximation: `lumaToValue` is affine, so the mean of the codes maps
 * to the mean of the values. The only loss is the rounding back to an
 * integer code, which is a quarter of one quantisation step and far
 * below the step itself.
 *
 * **Absent texels are excluded from the mean, not averaged into it.**
 * This is rule 1 from the module docstring wearing different clothes.
 * A box holding three texels of 50 dBZ and one of "nothing measured"
 * has a mean of 50 over the data present; treating the absent one as a
 * zero would report 37.5 and paint a gradient down the edge of every
 * echo — a smooth, plausible, entirely manufactured one. A box that is
 * mostly absent stays absent rather than reporting the mean of its
 * minority, so the no-data footprint erodes by at most half a box
 * instead of growing a fringe.
 *
 * **Texels outside `win` are excluded the same way.** A window edge
 * rarely lands on a box boundary, and a box straddling one would
 * otherwise average in source texels the caller excluded — letting
 * values from outside the picked region create or move an isoline
 * inside it. That is worse than it sounds, because `datasetStats`
 * reduces exactly the window: the panel would report statistics for one
 * region while drawing contours for a slightly larger one, and the two
 * would disagree at the edge for no visible reason. The majority test
 * counts in-window texels rather than the whole box, so an edge box
 * holding one in-window texel is judged on that texel instead of being
 * ruled absent by the neighbours it is not allowed to see.
 *
 * Only the boxes the walk will read are filled. The rest keep their
 * zeroes and are never looked at, which also means a small picked
 * region costs a small downsample rather than a whole-frame one.
 */
function downsample(
  snapshot: LumaSnapshot,
  table: CodeTable,
  stride: number,
  win: TexelWindow,
): LumaSnapshot {
  const { data, width, height } = snapshot
  const w = width / stride
  const h = height / stride
  const out = new Uint8Array(w * h)
  const { absentBelow } = table

  const bx0 = Math.max(0, Math.floor(win.x0 / stride))
  const by0 = Math.max(0, Math.floor(win.y0 / stride))
  const bx1 = Math.min(w, Math.ceil(win.x1 / stride))
  const by1 = Math.min(h, Math.ceil(win.y1 / stride))

  for (let y = by0; y < by1; y++) {
    const top = y * stride
    const sy0 = Math.max(top, win.y0)
    const sy1 = Math.min(top + stride, win.y1)
    for (let x = bx0; x < bx1; x++) {
      const left = x * stride
      const sx0 = Math.max(left, win.x0)
      const sx1 = Math.min(left + stride, win.x1)
      let sum = 0
      let present = 0
      let inWindow = 0
      for (let sy = sy0; sy < sy1; sy++) {
        const row = sy * width
        for (let sx = sx0; sx < sx1; sx++) {
          inWindow++
          const code = data[row + sx]
          if (code >= absentBelow) { sum += code; present++ }
        }
      }
      // Ties go to present: a box split evenly between data and no-data
      // has measured something, and the alternative erodes a coastline
      // by a box wherever the split happens to land at exactly half.
      out[y * w + x] = inWindow > 0 && present * 2 >= inWindow
        ? Math.round(sum / present)
        : 0
    }
  }
  return { data: out, width: w, height: h }
}

/**
 * A crossing point on one cell edge, identified by the edge rather than
 * by its coordinates.
 *
 * Two neighbouring cells share an edge and must produce the *same* node
 * there, or the polylines come out as thousands of disconnected
 * two-point stubs. Keying on the edge makes that exact. Keying on the
 * interpolated float coordinates would make it approximate, and the
 * epsilon would have to change with the frame's resolution.
 *
 * An integer rather than the `h${x},${y}` string this started as. Both
 * identify the same edge, but the string is built, hashed and collected
 * once per crossing, and there are hundreds of thousands of those on a
 * shipped frame — enough that it was most of the extraction's cost.
 * `(y * width + x) * 2 + orientation` is unique for every edge of a
 * frame and stays well inside the safe-integer range: even a
 * 16384 × 8192 frame tops out around 2.7e8.
 */
type EdgeKey = number

/** Horizontal edge between texel centres `(x, y)` and `(x + 1, y)`. */
function hKey(x: number, y: number, width: number): EdgeKey {
  return (y * width + x) * 2
}

/** Vertical edge between texel centres `(x, y)` and `(x, y + 1)`. */
function vKey(x: number, y: number, width: number): EdgeKey {
  return (y * width + x) * 2 + 1
}

interface Node {
  /** Fractional texel coordinates of the crossing, in centre space. */
  x: number
  y: number
  /** The at-most-two nodes this one connects to. A crossing sits on one
   *  edge, and an edge is shared by at most two cells, so a node cannot
   *  acquire a third neighbour on a well-formed field. */
  links: EdgeKey[]
}

/**
 * Ensure both endpoints of a segment exist and join them.
 *
 * One call rather than the create-then-link pair this replaced, because
 * the pair looked up each key twice — `has` then `set` to create, `get`
 * again to link — and the lookups are the hot path. The coordinates are
 * only used if the node is new; an edge already crossed by a
 * neighbouring cell keeps the position it was given first, which is the
 * same position, since both cells interpolate the same two corners.
 */
function connect(
  nodes: Map<EdgeKey, Node>,
  ka: EdgeKey, ax: number, ay: number,
  kb: EdgeKey, bx: number, by: number,
): void {
  if (ka === kb) return
  let na = nodes.get(ka)
  if (na === undefined) { na = { x: ax, y: ay, links: [] }; nodes.set(ka, na) }
  let nb = nodes.get(kb)
  if (nb === undefined) { nb = { x: bx, y: by, links: [] }; nodes.set(kb, nb) }
  if (!na.links.includes(kb)) na.links.push(kb)
  if (!nb.links.includes(ka)) nb.links.push(ka)
}

/**
 * Where along an edge the level falls, as a fraction from the first
 * corner to the second.
 *
 * `lumaToValue` is linear in luma, so interpolating in physical units
 * and interpolating in luma give the same point — this works in values
 * because that is what the caller reasons about. Equal corner values
 * cannot produce a crossing (the cell case would not have selected this
 * edge), but the guard keeps a degenerate frame from returning NaN.
 */
function crossFraction(va: number, vb: number, level: number): number {
  const span = vb - va
  if (span === 0) return 0.5
  const f = (level - va) / span
  return f < 0 ? 0 : f > 1 ? 1 : f
}

/**
 * Trace every level in one pass and return them as lat/lon polylines.
 *
 * The grid marched over is the lattice of texel *centres*, so a frame of
 * `w × h` texels contributes `(w − 1) × (h − 1)` cells and the outermost
 * half-texel is not contoured. That is the honest extent: there is no
 * data beyond the last centre to interpolate against, and extending to
 * the texel edge would mean inventing it.
 *
 * Levels are sorted and de-duplicated. A level with no crossings comes
 * back with an empty `lines` array rather than being dropped, so a
 * caller can tell "this level is outside the data" from "this level was
 * never asked for" — the difference between a legend entry that should
 * be greyed and one that should be absent.
 */
export function extractContourSet(
  snapshot: LumaSnapshot,
  scale: ColorScale,
  levels: number[],
  options?: DatasetOverlayOptions,
  window?: TexelWindow,
): ContourLevel[] {
  const wanted = [...new Set(levels.filter(v => Number.isFinite(v)))]
    .sort((a, b) => a - b)
    .slice(0, MAX_CONTOUR_LEVELS)
  if (!wanted.length) return []

  const empty = (): ContourLevel[] => wanted.map(value => ({ value, lines: [] }))
  if (snapshot.width < 2 || snapshot.height < 2) return empty()

  const table = buildCodeTable(scale)

  // The caller's window, in the caller's coordinates, clamped to the
  // frame. Resolved before decimation because decimation has to respect
  // it: see `downsample`.
  const win = window ?? fullWindow(snapshot)
  const nx0 = Math.max(0, Math.floor(win.x0))
  const ny0 = Math.max(0, Math.floor(win.y0))
  const nx1 = Math.min(snapshot.width, Math.ceil(win.x1))
  const ny1 = Math.min(snapshot.height, Math.ceil(win.y1))
  if (nx1 - nx0 < 2 || ny1 - ny0 < 2) return empty()

  const stride = table.absentIsLowBand
    ? chooseStride(snapshot.width, snapshot.height)
    : 1
  const frame = stride > 1
    ? downsample(snapshot, table, stride, { x0: nx0, y0: ny0, x1: nx1, y1: ny1 })
    : snapshot
  const { data, width, height } = frame

  // The same window in the decimated grid. Scaled rather than reused: a
  // window measured against the original frame and applied to the
  // decimated one would select a region `stride` times too large, which
  // is the kind of bug that produces a plausible picture of the wrong
  // place.
  const x0 = Math.max(0, Math.floor(nx0 / stride))
  const y0 = Math.max(0, Math.floor(ny0 / stride))
  const x1 = Math.min(width, Math.ceil(nx1 / stride))
  const y1 = Math.min(height, Math.ceil(ny1 / stride))
  if (x1 - x0 < 2 || y1 - y0 < 2) return empty()
  const nodesPerLevel = wanted.map(() => new Map<EdgeKey, Node>())
  const lowest = wanted[0]
  const highest = wanted[wanted.length - 1]

  // Hoisted out of a loop that runs once per cell — around 8.4 million
  // times on a shipped frame, where a property load per corner is not a
  // rounding error.
  const values = table.value
  const absentFlags = table.absent
  const { absentBelow, monotone } = table
  const levelCount = wanted.length

  for (let y = y0; y < y1 - 1; y++) {
    const rowA = y * width
    const rowB = rowA + width
    for (let x = x0; x < x1 - 1; x++) {
      // Corners clockwise from the top-left, in image space (y grows
      // downward), matching the snapshot's own row order.
      const c0 = data[rowA + x]
      const c1 = data[rowA + x + 1]
      const c2 = data[rowB + x + 1]
      const c3 = data[rowB + x]

      let cellMin: number
      let cellMax: number
      if (monotone) {
        // Both of the tests below answer from the *code* range, so a
        // cell crossed by no level — nearly all of them — never touches
        // the value table at all. This is the difference between the
        // extraction taking a moment and it locking the tab up.
        let lo = c0 < c1 ? c0 : c1
        if (c2 < lo) lo = c2
        if (c3 < lo) lo = c3
        // Rule 1, in one compare: absence is a contiguous low band, so
        // the lowest corner settles it for all four.
        if (lo < absentBelow) continue
        let hi = c0 > c1 ? c0 : c1
        if (c2 > hi) hi = c2
        if (c3 > hi) hi = c3
        cellMin = values[lo]
        cellMax = values[hi]
      } else {
        // Rule 1: one absent corner and the cell says nothing at all, at
        // any level.
        if (absentFlags[c0] || absentFlags[c1] || absentFlags[c2] || absentFlags[c3]) continue
        const a = values[c0]
        const b = values[c1]
        const c = values[c2]
        const d = values[c3]
        cellMin = a < b ? a : b
        if (c < cellMin) cellMin = c
        if (d < cellMin) cellMin = d
        cellMax = a > b ? a : b
        if (c > cellMax) cellMax = c
        if (d > cellMax) cellMax = d
      }

      // A level outside the cell's own range cannot cross it, which is
      // the early-out that makes the extra levels nearly free: on a
      // typical frame the overwhelming majority of cells are crossed by
      // no level at all.
      if (highest <= cellMin || lowest > cellMax) continue

      const v0 = values[c0]
      const v1 = values[c1]
      const v2 = values[c2]
      const v3 = values[c3]

      for (let li = 0; li < levelCount; li++) {
        const level = wanted[li]
        // `b = value >= level`, so every corner at or above the level
        // makes code 15 and every corner below makes code 0 — neither
        // emits a segment. These are exactly those two cases.
        if (level <= cellMin || level > cellMax) continue

        const nodes = nodesPerLevel[li]
        const code = (v0 >= level ? 1 : 0)
          | (v1 >= level ? 2 : 0)
          | (v2 >= level ? 4 : 0)
          | (v3 >= level ? 8 : 0)
        if (code === 0 || code === 15) continue

        // The cell's four edge identities and crossing positions, as
        // plain numbers. This used to be five closures, allocated on
        // every emitting cell and dead again before the switch ended;
        // measured on a 4096x2048 frame they and the string keys were
        // roughly nine tenths of the whole extraction. The two unused
        // `crossFraction` calls per cell are a subtract, a divide and a
        // clamp — far cheaper than the allocation they replace.
        const kTop = hKey(x, y, width)
        const kRight = vKey(x + 1, y, width)
        const kBottom = hKey(x, y + 1, width)
        const kLeft = vKey(x, y, width)
        const xTop = x + crossFraction(v0, v1, level)
        const yRight = y + crossFraction(v1, v2, level)
        const xBottom = x + crossFraction(v3, v2, level)
        const yLeft = y + crossFraction(v0, v3, level)
        const xRight = x + 1
        const yBottom = y + 1

        switch (code) {
          case 1: case 14: connect(nodes, kLeft, x, yLeft, kTop, xTop, y); break
          case 2: case 13: connect(nodes, kTop, xTop, y, kRight, xRight, yRight); break
          case 3: case 12: connect(nodes, kLeft, x, yLeft, kRight, xRight, yRight); break
          case 4: case 11: connect(nodes, kRight, xRight, yRight, kBottom, xBottom, yBottom); break
          case 6: case 9: connect(nodes, kTop, xTop, y, kBottom, xBottom, yBottom); break
          case 7: case 8: connect(nodes, kLeft, x, yLeft, kBottom, xBottom, yBottom); break
          // Saddles. Two opposite corners are above and two below, and
          // the cell alone cannot say whether the high ground is joined
          // or the low ground is. Resolved by the cell's own mean, the
          // usual convention: whichever side the centre falls on is the
          // side that stays connected.
          case 5: {
            if ((v0 + v1 + v2 + v3) / 4 >= level) {
              connect(nodes, kLeft, x, yLeft, kBottom, xBottom, yBottom)
              connect(nodes, kTop, xTop, y, kRight, xRight, yRight)
            } else {
              connect(nodes, kLeft, x, yLeft, kTop, xTop, y)
              connect(nodes, kRight, xRight, yRight, kBottom, xBottom, yBottom)
            }
            break
          }
          case 10: {
            if ((v0 + v1 + v2 + v3) / 4 >= level) {
              connect(nodes, kLeft, x, yLeft, kTop, xTop, y)
              connect(nodes, kRight, xRight, yRight, kBottom, xBottom, yBottom)
            } else {
              connect(nodes, kLeft, x, yLeft, kBottom, xBottom, yBottom)
              connect(nodes, kTop, xTop, y, kRight, xRight, yRight)
            }
            break
          }
        }
      }
    }
  }

  const minExtent = MIN_RING_EXTENT_FRACTION * Math.min(width, height)
  return wanted.map((value, li) => ({
    value,
    lines: assemble(nodesPerLevel[li], frame, options, minExtent),
  }))
}

/**
 * The isolines at a single level.
 *
 * The one-level case of `extractContourSet`, kept because a caller with
 * one threshold should not have to wrap it in an array and unwrap the
 * result.
 */
export function extractContours(
  snapshot: LumaSnapshot,
  scale: ColorScale,
  threshold: number,
  options?: DatasetOverlayOptions,
  window?: TexelWindow,
): ContourLine[] {
  return extractContourSet(snapshot, scale, [threshold], options, window)[0]?.lines ?? []
}

/**
 * Walk the crossing graph into polylines.
 *
 * Open runs are traced first, from their loose ends, because starting a
 * closed loop in the middle is harmless but starting an open line in the
 * middle would split it into two. Whatever is left after that is a
 * closed loop and gets its first point repeated at the end.
 */
function assemble(
  nodes: Map<EdgeKey, Node>,
  snapshot: LumaSnapshot,
  options?: DatasetOverlayOptions,
  minExtent = 0,
): ContourLine[] {
  if (!nodes.size) return []
  const visited = new Set<EdgeKey>()
  const runs: EdgeKey[][] = []

  const trace = (start: EdgeKey, closed: boolean): void => {
    const run: EdgeKey[] = []
    let current: EdgeKey | undefined = start
    let previous: EdgeKey | undefined
    while (current && !visited.has(current)) {
      visited.add(current)
      run.push(current)
      const node = nodes.get(current)
      if (!node) break
      const next: EdgeKey | undefined = node.links.find(
        k => k !== previous && !visited.has(k))
      previous = current
      current = next
    }
    if (run.length < 2) return
    if (closed) run.push(run[0])
    runs.push(run)
  }

  for (const [key, node] of nodes) {
    if (node.links.length === 1 && !visited.has(key)) trace(key, false)
  }
  for (const [key] of nodes) {
    if (!visited.has(key)) trace(key, true)
  }

  const lines: ContourLine[] = []
  for (const run of runs) {
    // Measured in texel space, before the projection, for two reasons.
    // It is the space the threshold is defined in — a fraction of the
    // frame — and it is the cheap one: rejecting here skips the
    // `texelUvToLatLon` call per point on exactly the runs there are
    // most of.
    if (minExtent > 0 && !spansAtLeast(nodes, run, minExtent)) continue
    const points = run.map((key): ContourPoint => {
      const node = nodes.get(key) as Node
      return texelUvToLatLon(
        {
          u: (node.x + 0.5) / snapshot.width,
          v: (node.y + 0.5) / snapshot.height,
        },
        options,
      )
    })
    lines.push(...splitAtSeam(points))
  }
  return lines
}

/**
 * Does this run reach `minExtent` texels across, in either axis?
 *
 * The longer axis decides, so a filament that is a hundred texels long
 * and one wide is kept — it is a real feature, and a rule reading area
 * or perimeter would discard it first. Only a run that is small in
 * *both* directions is a speckle ring.
 *
 * Exits as soon as the answer is yes, which on a real frame is usually
 * within a few points for the lines worth keeping, and never for the
 * ones being rejected.
 */
function spansAtLeast(
  nodes: Map<EdgeKey, Node>,
  run: EdgeKey[],
  minExtent: number,
): boolean {
  const first = nodes.get(run[0])
  if (!first) return false
  let minX = first.x
  let maxX = first.x
  let minY = first.y
  let maxY = first.y
  for (let i = 1; i < run.length; i++) {
    const node = nodes.get(run[i])
    if (!node) continue
    if (node.x < minX) minX = node.x
    else if (node.x > maxX) maxX = node.x
    if (node.y < minY) minY = node.y
    else if (node.y > maxY) maxY = node.y
    if (maxX - minX >= minExtent || maxY - minY >= minExtent) return true
  }
  return false
}

/**
 * Cut a polyline wherever consecutive longitudes jump the antimeridian.
 *
 * Exported because the same cut applies to any lat/lon path handed to
 * MapLibre, and because it is the piece most worth testing directly: a
 * line that wraps looks fine in the data and draws as a band across the
 * whole globe.
 */
export function splitAtSeam(points: ContourPoint[]): ContourLine[] {
  if (points.length < 2) return points.length ? [points] : []
  const out: ContourLine[] = []
  let run: ContourPoint[] = [points[0]]
  for (let i = 1; i < points.length; i++) {
    const jumped = Math.abs(points[i].lon - points[i - 1].lon) > SEAM_JUMP_DEGREES
    if (jumped) {
      if (run.length >= 2) out.push(run)
      run = [points[i]]
    } else {
      run.push(points[i])
    }
  }
  if (run.length >= 2) out.push(run)
  return out
}

/**
 * One level's lines as a GeoJSON MultiLineString feature.
 *
 * Kept here rather than in the renderer so the shape handed to MapLibre
 * is covered by this module's tests, the same way `boundsRing` is shared
 * with `showRegionOutline`.
 */
export function contoursToGeoJson(lines: ContourLine[]): GeoJSON.Feature {
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'MultiLineString',
      coordinates: lines.map(line => line.map((p): [number, number] => [p.lon, p.lat])),
    },
  }
}

/**
 * A whole contour set as one GeoJSON FeatureCollection, one feature per
 * level.
 *
 * `value` and `color` ride along as properties so the map can paint each
 * isoline from its own level with a data-driven expression, rather than
 * the renderer needing one source and one layer per level.
 *
 * Levels that traced nothing are omitted: an empty MultiLineString is a
 * feature MapLibre has to carry and can never draw.
 */
export function contourSetToGeoJson(levels: ContourLevel[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: levels
      .filter(level => level.lines.length > 0)
      .map(level => ({
        type: 'Feature',
        properties: { value: level.value, color: level.color ?? '#ffd166' },
        geometry: {
          type: 'MultiLineString',
          coordinates: level.lines.map(
            line => line.map((p): [number, number] => [p.lon, p.lat])),
        },
      })),
  }
}
