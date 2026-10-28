// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Geometry for the exhibit's mesh furniture (docs/SECOND_LIFE_COMPAT.md
 * §9 Phase 5, "The furniture's look"). A handful of builders that emit
 * triangles in Second Life's frame: metres, Z up. Each `Part` belongs to
 * one material, and a material becomes one face of the uploaded mesh, so
 * which part carries which material is the contract with the dress script.
 *
 * Every builder takes its segment counts as arguments, because the same
 * function draws each level of detail: Second Life switches to a coarser
 * model as an object shrinks on screen, and one it generates for itself
 * tends to collapse thin shapes into nothing.
 *
 * Pure: no files, no randomness, so the same call always writes the same
 * numbers and a committed model can be checked against a fresh build.
 */

export type Vec2 = readonly [number, number]
export type Vec3 = readonly [number, number, number]

export interface Part {
  material: string
  positions: number[]
  normals: number[]
  uvs: number[]
  indices: number[]
}

export function part(material: string): Part {
  return { material, positions: [], normals: [], uvs: [], indices: [] }
}

function vertex(p: Part, pos: Vec3, n: Vec3, uv: Vec2): number {
  p.positions.push(pos[0], pos[1], pos[2])
  p.normals.push(n[0], n[1], n[2])
  p.uvs.push(uv[0], uv[1])
  return p.positions.length / 3 - 1
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2])
export function normalize(a: Vec3): Vec3 {
  const l = length(a)
  return l === 0 ? [0, 0, 1] : [a[0] / l, a[1] / l, a[2] / l]
}

function at(p: Part, i: number): Vec3 {
  return [p.positions[3 * i], p.positions[3 * i + 1], p.positions[3 * i + 2]]
}
function normalAt(p: Part, i: number): Vec3 {
  return [p.normals[3 * i], p.normals[3 * i + 1], p.normals[3 * i + 2]]
}

/**
 * One triangle, wound so its geometric normal agrees with its vertices'
 * stored normals: Second Life draws a face from the side its winding
 * says is the front, and a builder that got one quad backwards would
 * leave a hole seen from outside. A triangle with no area (a lathe's
 * ring at the axis) is dropped.
 */
function triangle(p: Part, a: number, b: number, c: number): void {
  const n = cross(sub(at(p, b), at(p, a)), sub(at(p, c), at(p, a)))
  if (length(n) < 1e-12) return
  const want = normalAt(p, a)
  const has = [normalAt(p, b), normalAt(p, c)].reduce((s, m) => [s[0] + m[0], s[1] + m[1], s[2] + m[2]] as Vec3, want)
  if (dot(n, has) >= 0) p.indices.push(a, b, c)
  else p.indices.push(a, c, b)
}

function quad(p: Part, a: number, b: number, c: number, d: number): void {
  triangle(p, a, b, c)
  triangle(p, a, c, d)
}

/**
 * A surface of revolution about Z. `profile` is (radius, height) pairs
 * running counter-clockwise when radius points right and height up:
 * out along the bottom, up the outside, back in along the top. A corner
 * sharper than `smoothDeg` keeps a crease; gentler ones are smoothed.
 * U runs round the axis and V along the profile, by length.
 */
export function lathe(material: string, profile: readonly Vec2[], segments: number, smoothDeg = 35): Part {
  const p = part(material)
  const edges = profile.slice(0, -1).map((a, i) => {
    const b = profile[i + 1]
    const dr = b[0] - a[0], dz = b[1] - a[1]
    const l = Math.hypot(dr, dz)
    return { a, b, n: [dz / l, -dr / l] as Vec2, len: l }
  })
  const total = edges.reduce((s, e) => s + e.len, 0)
  const cosSmooth = Math.cos((smoothDeg * Math.PI) / 180)
  const blend = (m: Vec2, o: Vec2 | undefined): Vec2 => {
    if (!o || m[0] * o[0] + m[1] * o[1] < cosSmooth) return m
    const s: Vec2 = [m[0] + o[0], m[1] + o[1]]
    const l = Math.hypot(s[0], s[1])
    return [s[0] / l, s[1] / l]
  }
  let run = 0
  edges.forEach((e, i) => {
    if (e.len < 1e-9) return
    const nStart = blend(e.n, edges[i - 1]?.n)
    const nEnd = blend(e.n, edges[i + 1]?.n)
    const v0 = run / total, v1 = (run + e.len) / total
    run += e.len
    const ring: number[][] = [[], []]
    for (let s = 0; s <= segments; s++) {
      const t = (s / segments) * Math.PI * 2
      const c = Math.cos(t), sn = Math.sin(t)
      ring[0].push(vertex(p, [e.a[0] * c, e.a[0] * sn, e.a[1]], normalize([nStart[0] * c, nStart[0] * sn, nStart[1]]), [s / segments, v0]))
      ring[1].push(vertex(p, [e.b[0] * c, e.b[0] * sn, e.b[1]], normalize([nEnd[0] * c, nEnd[0] * sn, nEnd[1]]), [s / segments, v1]))
    }
    for (let s = 0; s < segments; s++) quad(p, ring[0][s], ring[0][s + 1], ring[1][s + 1], ring[1][s])
  })
  return p
}

/**
 * A smooth curve through profile points, for a lathe that should flow
 * rather than step: a Catmull-Rom spline with `samples` points per span.
 * The first and last points are kept exactly, so a run of curve can be
 * joined to straight edges and corners on either side.
 */
export function smoothRun(points: readonly Vec2[], samples: number): Vec2[] {
  if (samples <= 1 || points.length < 3) return points.slice()
  const out: Vec2[] = []
  const P = (i: number) => points[Math.max(0, Math.min(points.length - 1, i))]
  for (let i = 0; i < points.length - 1; i++) {
    const [p0, p1, p2, p3] = [P(i - 1), P(i), P(i + 1), P(i + 2)]
    for (let k = 0; k < samples; k++) {
      const t = k / samples, t2 = t * t, t3 = t2 * t
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])])
    }
  }
  out.push(points[points.length - 1])
  return out
}

/** A torus about Z, centred at height `z`: the accent lines. */
export function torus(material: string, major: number, tube: number, z: number, segments: number, tubeSegments: number): Part {
  const p = part(material)
  const grid: number[][] = []
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2
    const row: number[] = []
    for (let j = 0; j <= tubeSegments; j++) {
      const f = (j / tubeSegments) * Math.PI * 2
      const n: Vec3 = [Math.cos(f) * Math.cos(t), Math.cos(f) * Math.sin(t), Math.sin(f)]
      const r = major + tube * Math.cos(f)
      row.push(vertex(p, [r * Math.cos(t), r * Math.sin(t), z + tube * Math.sin(f)], n, [i / segments, j / tubeSegments]))
    }
    grid.push(row)
  }
  for (let i = 0; i < segments; i++) for (let j = 0; j < tubeSegments; j++) quad(p, grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1])
  return p
}

/**
 * The steps across one axis of a rounded box: a quarter of each rounded
 * edge's arc at either end, the flat run between. The arc is spaced by
 * angle, through `tan`, because the points are projected onto it from a
 * flat face, and spacing them evenly on the face would bunch them at the
 * crease.
 */
function boxSteps(size: number, radius: number, segments: number): number[] {
  if (segments === 0 || radius === 0) return [-size / 2, size / 2]
  const steps: number[] = []
  for (let k = 0; k <= segments; k++) {
    const phi = (Math.PI / 4) * (1 - k / segments)
    steps.push(-size / 2 + radius - radius * Math.tan(phi))
  }
  return [...steps, ...steps.slice().reverse().map(x => -x)]
}

/**
 * A box with rounded edges, centred on the origin. Each face is a grid
 * on the box's surface, pulled onto the rounded shape by clamping each
 * point into the inner box and pushing it back out by the radius, which
 * makes the corners true quarter-spheres and the faces meet without a
 * seam. Zero segments gives a plain box. UVs are planar per face.
 */
export function roundedBox(material: string, size: Vec3, radius: number, segments: number): Part {
  const p = part(material)
  const r = segments === 0 ? 0 : Math.min(radius, size[0] / 2, size[1] / 2, size[2] / 2)
  const half: Vec3 = [size[0] / 2, size[1] / 2, size[2] / 2]
  const inner: Vec3 = [half[0] - r, half[1] - r, half[2] - r]
  // Each face: its fixed axis and side, then its two in-plane axes.
  const faces: [number, number, number, number][] = [[0, 1, 1, 2], [0, -1, 2, 1], [1, 1, 2, 0], [1, -1, 0, 2], [2, 1, 0, 1], [2, -1, 1, 0]]
  for (const [axis, side, ua, va] of faces) {
    const us = boxSteps(size[ua], r, segments), vs = boxSteps(size[va], r, segments)
    const grid: number[][] = []
    us.forEach((u, i) => {
      const row: number[] = []
      vs.forEach((v, j) => {
        const pt = [0, 0, 0]
        pt[axis] = side * half[axis]; pt[ua] = u; pt[va] = v
        const q = pt.map((x, k) => Math.max(-inner[k], Math.min(inner[k], x))) as unknown as Vec3
        const flat: Vec3 = [0, 0, 0].map((_, k) => (k === axis ? side : 0)) as unknown as Vec3
        const n = r === 0 ? flat : normalize(sub(pt as unknown as Vec3, q))
        const pos: Vec3 = r === 0 ? (pt as unknown as Vec3) : [q[0] + n[0] * r, q[1] + n[1] * r, q[2] + n[2] * r]
        row.push(vertex(p, pos, n, [i / (us.length - 1), j / (vs.length - 1)]))
      })
      grid.push(row)
    })
    for (let i = 0; i < us.length - 1; i++) for (let j = 0; j < vs.length - 1; j++) quad(p, grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1])
  }
  return p
}

/**
 * A convex outline with its corners rounded, as points running
 * counter-clockwise. Used for the console's blade, seen from the front.
 */
export function filletOutline(corners: readonly Vec2[], radius: number, segments: number): Vec2[] {
  if (segments === 0 || radius === 0) return corners.slice()
  const out: Vec2[] = []
  corners.forEach((c, i) => {
    const prev = corners[(i + corners.length - 1) % corners.length], next = corners[(i + 1) % corners.length]
    const toPrev = norm2([prev[0] - c[0], prev[1] - c[1]]), toNext = norm2([next[0] - c[0], next[1] - c[1]])
    const half = Math.acos(Math.max(-1, Math.min(1, toPrev[0] * toNext[0] + toPrev[1] * toNext[1]))) / 2
    const back = radius / Math.tan(half)
    const centreDist = radius / Math.sin(half)
    const bis = norm2([toPrev[0] + toNext[0], toPrev[1] + toNext[1]])
    const centre: Vec2 = [c[0] + bis[0] * centreDist, c[1] + bis[1] * centreDist]
    const start: Vec2 = [c[0] + toPrev[0] * back, c[1] + toPrev[1] * back]
    const end: Vec2 = [c[0] + toNext[0] * back, c[1] + toNext[1] * back]
    const a0 = Math.atan2(start[1] - centre[1], start[0] - centre[0])
    let a1 = Math.atan2(end[1] - centre[1], end[0] - centre[0])
    while (a1 < a0) a1 += Math.PI * 2
    if (a1 - a0 > Math.PI) a1 -= Math.PI * 2
    for (let k = 0; k <= segments; k++) {
      const a = a0 + ((a1 - a0) * k) / segments
      out.push([centre[0] + radius * Math.cos(a), centre[1] + radius * Math.sin(a)])
    }
  })
  return out
}

function norm2(v: Vec2): Vec2 {
  const l = Math.hypot(v[0], v[1])
  return [v[0] / l, v[1] / l]
}

/**
 * A slab with a convex outline drawn in the Y-Z plane, `depth` thick
 * along X and centred on it. Its sides are smoothed round the rounded
 * corners and creased at the faces.
 */
export function extrudeYZ(material: string, outline: readonly Vec2[], depth: number): Part {
  const p = part(material)
  const n = outline.length
  const edgeNormal = (i: number): Vec2 => {
    const a = outline[i], b = outline[(i + 1) % n]
    return norm2([b[1] - a[1], -(b[0] - a[0])])
  }
  const cosSmooth = Math.cos((35 * Math.PI) / 180)
  for (let i = 0; i < n; i++) {
    const a = outline[i], b = outline[(i + 1) % n]
    const ne = edgeNormal(i)
    const np = edgeNormal((i + n - 1) % n), nn = edgeNormal((i + 1) % n)
    const at0 = ne[0] * np[0] + ne[1] * np[1] > cosSmooth ? norm2([ne[0] + np[0], ne[1] + np[1]]) : ne
    const at1 = ne[0] * nn[0] + ne[1] * nn[1] > cosSmooth ? norm2([ne[0] + nn[0], ne[1] + nn[1]]) : ne
    const v = (x: number, q: Vec2, m: Vec2, u: number) => vertex(p, [x, q[0], q[1]], [0, m[0], m[1]], [u, x > 0 ? 1 : 0])
    quad(p, v(-depth / 2, a, at0, i / n), v(-depth / 2, b, at1, (i + 1) / n), v(depth / 2, b, at1, (i + 1) / n), v(depth / 2, a, at0, i / n))
  }
  const ys = outline.map(q => q[0]), zs = outline.map(q => q[1])
  const [y0, y1, z0, z1] = [Math.min(...ys), Math.max(...ys), Math.min(...zs), Math.max(...zs)]
  for (const side of [-1, 1]) {
    const x = (side * depth) / 2
    const uv = (q: Vec2): Vec2 => [(q[0] - y0) / (y1 - y0), (q[1] - z0) / (z1 - z0)]
    const cy = ys.reduce((s, y) => s + y, 0) / n, cz = zs.reduce((s, z) => s + z, 0) / n
    const c = vertex(p, [x, cy, cz], [side, 0, 0], uv([cy, cz]))
    const ring = outline.map(q => vertex(p, [x, q[0], q[1]], [side, 0, 0], uv(q)))
    for (let i = 0; i < n; i++) triangle(p, c, ring[i], ring[(i + 1) % n])
  }
  return p
}

/**
 * A flat rectangle facing +Z with UVs filling 0..1, `uAxis` along +Y and
 * V along -X: a texture face that reads the right way up for someone
 * standing on the +X side, as a visitor at the console does.
 */
export function labelQuad(material: string, sizeX: number, sizeY: number, z: number): Part {
  const p = part(material)
  const up: Vec3 = [0, 0, 1]
  const a = vertex(p, [sizeX / 2, -sizeY / 2, z], up, [0, 0])
  const b = vertex(p, [sizeX / 2, sizeY / 2, z], up, [1, 0])
  const c = vertex(p, [-sizeX / 2, sizeY / 2, z], up, [1, 1])
  const d = vertex(p, [-sizeX / 2, -sizeY / 2, z], up, [0, 1])
  quad(p, a, b, c, d)
  return p
}

/** A flat disc or ring facing +Z; UVs map the disc's square to 0..1. */
export function annulus(material: string, inner: number, outer: number, z: number, segments: number): Part {
  const p = part(material)
  const up: Vec3 = [0, 0, 1]
  const uv = (x: number, y: number): Vec2 => [0.5 + x / (2 * outer), 0.5 + y / (2 * outer)]
  if (inner <= 0) {
    const c = vertex(p, [0, 0, z], up, [0.5, 0.5])
    const ring: number[] = []
    for (let s = 0; s <= segments; s++) {
      const t = (s / segments) * Math.PI * 2
      ring.push(vertex(p, [outer * Math.cos(t), outer * Math.sin(t), z], up, uv(outer * Math.cos(t), outer * Math.sin(t))))
    }
    for (let s = 0; s < segments; s++) triangle(p, c, ring[s], ring[s + 1])
    return p
  }
  const rings = [inner, outer].map(r => {
    const ring: number[] = []
    for (let s = 0; s <= segments; s++) {
      const t = (s / segments) * Math.PI * 2
      ring.push(vertex(p, [r * Math.cos(t), r * Math.sin(t), z], up, uv(r * Math.cos(t), r * Math.sin(t))))
    }
    return ring
  })
  for (let s = 0; s < segments; s++) quad(p, rings[0][s], rings[0][s + 1], rings[1][s + 1], rings[1][s])
  return p
}

/** A convex prism: a regular polygon of `sides` from z0 to z1. Physics only. */
export function prism(material: string, radius: number, z0: number, z1: number, sides: number): Part {
  const pts: Vec2[] = [[0, z0], [radius, z0], [radius, z1], [0, z1]]
  return lathe(material, pts, sides, 0)
}

/** A plain box between two corners. Physics only. */
export function box(material: string, min: Vec3, max: Vec3): Part {
  const p = roundedBox(material, [max[0] - min[0], max[1] - min[1], max[2] - min[2]], 0, 0)
  return transform(p, { translate: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] })
}

export interface Transform {
  /** Rotation about Y in radians, applied before the translation. */
  rotateY?: number
  translate?: Vec3
}

/** A copy of a part moved and turned; normals turn with it. */
export function transform(src: Part, t: Transform): Part {
  const p = part(src.material)
  const a = t.rotateY ?? 0
  const c = Math.cos(a), s = Math.sin(a)
  const [tx, ty, tz] = t.translate ?? [0, 0, 0]
  for (let i = 0; i < src.positions.length; i += 3) {
    const [x, y, z] = [src.positions[i], src.positions[i + 1], src.positions[i + 2]]
    const [nx, ny, nz] = [src.normals[i], src.normals[i + 1], src.normals[i + 2]]
    p.positions.push(x * c + z * s + tx, y + ty, -x * s + z * c + tz)
    p.normals.push(nx * c + nz * s, ny, -nx * s + nz * c)
  }
  p.uvs = src.uvs.slice()
  p.indices = src.indices.slice()
  return p
}

/**
 * Parts of one material joined into one, so a piece hands the writer
 * exactly one part per face. The order of first appearance is kept: it
 * is the face numbering.
 */
export function mergeByMaterial(parts: readonly Part[]): Part[] {
  const out: Part[] = []
  for (const src of parts) {
    let dst = out.find(p => p.material === src.material)
    if (!dst) { dst = part(src.material); out.push(dst) }
    const base = dst.positions.length / 3
    dst.positions.push(...src.positions)
    dst.normals.push(...src.normals)
    dst.uvs.push(...src.uvs)
    dst.indices.push(...src.indices.map(i => i + base))
  }
  return out
}

/** Axis-aligned bounds of a set of parts. */
export function bounds(parts: readonly Part[]): { min: Vec3; max: Vec3 } {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (const p of parts) for (let i = 0; i < p.positions.length; i += 3) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], p.positions[i + k]); max[k] = Math.max(max[k], p.positions[i + k])
  }
  return { min: min as unknown as Vec3, max: max as unknown as Vec3 }
}

export function triangleCount(parts: readonly Part[]): number {
  return parts.reduce((s, p) => s + p.indices.length / 3, 0)
}
