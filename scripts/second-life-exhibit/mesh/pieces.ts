// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The exhibit's mesh pieces, first batch (docs/SECOND_LIFE_COMPAT.md §9
 * Phase 5, "The building" and "The furniture's look"): the stem the
 * exhibit globe stands on, the plinth under it, the console, and the key
 * every console button is made of.
 *
 * Each piece is built four times, from detailed to crude, because Second
 * Life swaps in a coarser model as an object gets small on screen: the
 * `lods` are high, medium, low and lowest, in the order the uploader's
 * level-of-detail slots take them. Each also has a physics shape, a few
 * convex triangles, since a visitor walking into the stem should bump a
 * cylinder rather than have the region test every facet.
 *
 * `faces` is the order of the piece's materials, which is the face
 * numbering in-world: the COLLADA writer names each face for its place
 * so Second Life's alphabetical sort keeps this order. The dress script
 * (`terraviz-dress.lsl`) paints by these numbers, and `mesh.test.ts`
 * holds the two equal.
 *
 * The uploader scales every level, and the physics shape, to fill its
 * own bounding box, then stretches each to the high level's. So all of
 * them share the high level's box: segment counts are multiples of four,
 * which keeps a round piece's extremes in every level, and the physics
 * shape is built from the high level's bounds.
 *
 * The frame is Second Life's: metres, Z up, +X the front. Second Life
 * centres an upload on its bounding box, so where a piece sits is set
 * in-world, not here; the README gives the heights that line them up.
 */
import {
  annulus, bounds, box, extrudeYZ, filletOutline, labelQuad, lathe, mergeByMaterial, prism, roundedBox, smoothRun, torus, transform,
  type Part, type Vec2,
} from './geometry'

export interface Piece {
  name: string
  /** Material names in face order: face 0 first. */
  faces: readonly string[]
  /** High, medium, low, lowest. */
  lods: readonly Part[][]
  physics: Part[]
  /** What the piece is, for the README and the uploader's model name. */
  description: string
}

export const LOD_NAMES = ['high', 'medium', 'low', 'lowest'] as const

/** The exhibit globe the stem is sized for: 3 m across, its lowest point 1 m up. */
export const GLOBE = { diameter: 3, bottom: 1.0 }

/**
 * The stem's outline, from the concept's 3 m globe: crisp at the floor
 * and at the cup's rim, one smooth curve from the base's flare up the
 * column into the cup, sampled more finely for the finer models.
 */
function stemProfile(top: number, samples: number): Vec2[] {
  const curve = smoothRun([[0.48, 0.05], [0.2, 0.16], [0.11, 0.42], [0.085, top - 0.2], [0.15, top - 0.06], [0.44, top]], samples)
  return [[0, 0], [0.5, 0], ...curve, [0, top]]
}

/**
 * The stem: a lathed stand flaring out to a shallow cup under the globe,
 * with one accent line at the cup's rim. The globe floats a few
 * centimetres above the cup rather than touching it.
 */
function stem(): Piece {
  const top = GLOBE.bottom - 0.02
  const faces = ['body', 'accent'] as const
  // The accent's tube keeps a multiple of four sides at every level, so
  // its top, the stem's highest point, is in each one.
  const levels: [number, number, number, number][] = [[48, 48, 8, 4], [32, 32, 4, 3], [16, 16, 4, 2], [8, 8, 4, 1]]
  const lods = levels.map(([seg, ringSeg, tubeSeg, samples]) => mergeByMaterial([
    lathe('body', stemProfile(top, samples), seg),
    torus('accent', 0.43, 0.007, top - 0.004, ringSeg, tubeSeg),
  ]))
  const b = bounds(lods[0])
  return {
    name: 'terraviz-stem',
    description: `Stand for the ${GLOBE.diameter} m exhibit globe; its cup sits ${num(top)} m up, just under the globe`,
    faces,
    lods,
    physics: [prism('physics', b.max[0], b.min[2], b.max[2], 8)],
  }
}

/** The disc the stem stands on, with an accent line inlaid near its edge. */
function plinth(): Piece {
  const r = 2.1, h = 0.07, e = 0.025
  const ring = [1.943, 1.957] as const
  const arc = (cz: number, from: number, to: number, steps: number): Vec2[] =>
    Array.from({ length: steps + 1 }, (_, k) => {
      const a = from + ((to - from) * k) / steps
      return [r - e + e * Math.cos(a), cz + e * Math.sin(a)] as Vec2
    })
  // The inlay is a band of the top itself, not a ring laid on it: the
  // body's top stops at the band's outer edge and starts again at its
  // inner one, all three sharing their seams, so nothing sits at nearly
  // the same depth as anything else to flicker from far off. Flat rather
  // than a torus, it reads the same from any height a visitor sees the
  // plinth from, at a twentieth of the triangles; a 4 m piece is seen
  // from far off, and Second Life charges its land impact by that.
  const profile = (steps: number): Vec2[] => [[0, 0], ...arc(e, -Math.PI / 2, 0, steps), ...arc(h - e, 0, Math.PI / 2, steps), [ring[1], h]]
  const levels: [number, number][] = [[96, 3], [48, 2], [24, 1], [12, 1]]
  const lods = levels.map(([seg, edgeSteps]) => mergeByMaterial([
    lathe('body', profile(edgeSteps), seg),
    annulus('body', 0, ring[0], h, seg),
    annulus('accent', ring[0], ring[1], h, seg),
  ]))
  const b = bounds(lods[0])
  return {
    name: 'terraviz-plinth',
    description: `Plinth ${r * 2} m across and ${h} m high, under the stem`,
    faces: ['body', 'accent'],
    lods,
    physics: [prism('physics', b.max[0], b.min[2], b.max[2], 16)],
  }
}

/**
 * The console's top panel: its tilt, size, thickness, the height of its
 * centre, and the radius of its rounded edges. Shared with the key
 * layout, whose keys stay on the flat top inside those edges.
 */
export const PANEL = { tilt: 0.38, sizeX: 0.62, sizeY: 1.24, thickness: 0.05, height: 1.0, radius: 0.02 }

/**
 * The console's blade, seen from the front: a trapezoid in Y and Z,
 * `depth` thick along X. Its top runs up into the panel, where the
 * panel's slab hides it at both faces, so its top corners stay sharp.
 */
export const BLADE = { outline: [[-0.13, 0.04], [0.13, 0.04], [0.4, 1.0], [-0.4, 1.0]] as Vec2[], fillets: [0.03, 0.03, 0, 0], depth: 0.1 }

/**
 * The console: a base plate, a flared blade, and a top panel tilted
 * toward the visitor, who stands on the +X side. The panel's flat top,
 * inside its rounded edges, is a face of its own (`panel`), mapped 0..1
 * so the group labels can be one texture; the accent runs along its
 * front edge.
 */
function consoleBody(): Piece {
  // The panel and its accent keep at least one step of rounding at every
  // level: their tilted edges set the console's bounding box, and a sharp
  // edge juts a centimetre further than a rounded one.
  const levels = [{ box: 4, fillet: 4 }, { box: 2, fillet: 2 }, { box: 1, fillet: 1 }, { box: 0, fillet: 0 }]
  const onPanel = (p: Part) => transform(p, { rotateY: PANEL.tilt, translate: [0, 0, PANEL.height] })
  const flat = (size: number) => size - 2 * PANEL.radius
  const lods = levels.map(l => mergeByMaterial([
    transform(roundedBox('body', [0.52, 1.0, 0.04], 0.015, l.box), { translate: [0, 0, 0.02] }),
    extrudeYZ('body', filletOutline(BLADE.outline, BLADE.fillets, l.fillet), BLADE.depth),
    onPanel(roundedBox('body', [PANEL.sizeX, PANEL.sizeY, PANEL.thickness], PANEL.radius, Math.max(l.box, 1), true)),
    onPanel(labelQuad('panel', flat(PANEL.sizeX), flat(PANEL.sizeY), PANEL.thickness / 2)),
    onPanel(transform(roundedBox('accent', [0.006, 1.12, 0.006], 0.003, Math.min(Math.max(l.box, 1), 2)), { translate: [PANEL.sizeX / 2 + 0.002, 0, 0] })),
  ]))
  const b = bounds(lods[0])
  return {
    name: 'terraviz-console',
    description: 'Console: base, blade and a top panel tilted 22 degrees toward the visitor on its +X side',
    faces: ['body', 'panel', 'accent'],
    lods,
    physics: [box('physics', b.min, b.max)],
  }
}

/**
 * One console button: a short cylinder whose top is two faces, a cap
 * that shows one icon (a cell of a texture sheet, picked by the
 * script's texture offsets) and a thin ring that glows when pressed.
 */
export const KEY = { radius: 0.036, height: 0.024 }
function key(): Piece {
  const r = KEY.radius, h = KEY.height
  // The body's top lip, the ring and the cap are one flat top in three
  // bands, sharing their seams.
  const levels = [40, 24, 12, 8]
  const lods = levels.map(seg => mergeByMaterial([
    lathe('body', [[0, 0], [r * 1.03, 0], [r, h], [r * 0.98, h]], seg),
    annulus('cap', 0, r * 0.86, h, seg),
    annulus('ring', r * 0.86, r * 0.98, h, seg),
  ]))
  const b = bounds(lods[0])
  return {
    name: 'terraviz-key',
    description: `Console button, ${num(r * 2 * 100)} cm across`,
    faces: ['body', 'cap', 'ring'],
    lods,
    physics: [box('physics', b.min, b.max)],
  }
}

/**
 * Where the console's buttons sit on its panel, in the panel's own frame
 * (X toward the visitor, Y to their right, on the top surface): the
 * layout the concept renders were reviewed with. The console script,
 * when it is written, carries an LSL copy of this table, and a test
 * holds the two equal as `exhibit.test.ts` does the message numbers.
 */
export const KEY_LAYOUT: readonly { id: string; x: number; y: number; big?: boolean }[] = [
  { id: 'step-back', x: -0.06, y: -0.5 }, { id: 'play', x: -0.06, y: -0.38, big: true }, { id: 'step-forward', x: -0.06, y: -0.26 },
  { id: 'slower', x: 0.1, y: -0.44 }, { id: 'faster', x: 0.1, y: -0.32 },
  { id: 'home', x: 0.01, y: 0.02 }, { id: 'north', x: -0.105, y: 0.02 }, { id: 'south', x: 0.125, y: 0.02 },
  { id: 'west', x: 0.01, y: -0.095 }, { id: 'east', x: 0.01, y: 0.135 },
  { id: 'zoom-in', x: -0.06, y: 0.245 }, { id: 'zoom-out', x: 0.08, y: 0.245 },
  { id: 'earth', x: -0.08, y: 0.46 }, { id: 'previous', x: 0.08, y: 0.4 }, { id: 'next', x: 0.08, y: 0.52 },
]

function num(x: number): string {
  return String(Math.round(x * 1000) / 1000)
}

export function pieces(): Piece[] {
  return [stem(), plinth(), consoleBody(), key()]
}
