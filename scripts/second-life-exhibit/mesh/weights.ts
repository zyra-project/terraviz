// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * An estimate of a piece's land impact before it is uploaded, by
 * Second Life's own arithmetic for a mesh's download weight, which is
 * what sets the land impact of every piece here (their physics and server
 * weights are smaller).
 *
 * The viewer (`indra/newview/llmeshrepository.cpp`, `LLMeshCostData` and
 * `getRadiusBasedStreamingCost`) weighs each level of detail by the size
 * of its block in the uploaded asset: an LLSD-binary array of faces, each
 * with its positions, normals and texture coordinates as 16-bit numbers
 * over the face's own range and its triangles as 16-bit indices
 * (`indra/llprimitive/llmodel.cpp`, `writeModel`), compressed with zlib at
 * its best. A level's size, less 384 bytes for the format's own keys,
 * over 16, counts as its triangles. Each level counts for the share of a
 * region that sees it: a piece of radius r (half its bounding box's
 * diagonal) shows its high level to r / 0.24 m, its medium to r / 0.06,
 * its low to r / 0.03 and its lowest beyond, out to the 102,944 m² of a
 * region. The weighted triangles times 15,000 / 250,000 is the weight.
 *
 * It overestimates. Linden Lab has since cut every mesh's download weight
 * by 15% across the grid, and the uploader reorders each face's triangles
 * and vertices for the graphics card, which this doesn't, and which
 * compresses better: the stem, plinth and console uploaded on 28 October 2026 came in
 * at 0.76 to 0.87 of these figures (`CALIBRATION` is their middle; the
 * key's reading, 1, is rounded too coarsely to say). So it is for
 * comparing one build of a piece with another, and for budgets, rather
 * than for an exact figure; the uploader's "Calculate weights & fee" is
 * the real one.
 */
import { deflateSync } from 'node:zlib'
import { bounds, type Part } from './geometry'

/** What the uploader charged, over this file's figure, for the pieces
 *  uploaded on 28 October 2026 (0.76 to 0.87). */
export const CALIBRATION = 0.8

const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
const real = (x: number): Buffer => { const b = Buffer.alloc(9); b[0] = 0x72; b.writeDoubleBE(x, 1); return b }
const binary = (b: Buffer): Buffer => Buffer.concat([Buffer.from('b'), u32(b.length), b])
const array = (items: Buffer[]): Buffer => Buffer.concat([Buffer.from('['), u32(items.length), ...items, Buffer.from(']')])
const map = (entries: [string, Buffer][]): Buffer => Buffer.concat([
  Buffer.from('{'), u32(entries.length),
  // LLSD maps are written in key order.
  ...[...entries].sort(([a], [b]) => (a < b ? -1 : 1)).flatMap(([k, v]) => [Buffer.from('k'), u32(k.length), Buffer.from(k), v]),
  Buffer.from('}'),
])

/** Each of `count` values of `size` components as 16 bits over their own range. */
function quantized(values: readonly number[], size: number): { data: Buffer; min: number[]; max: number[] } {
  const count = values.length / size
  const min = Array.from({ length: size }, (_, k) => Math.min(...Array.from({ length: count }, (_, i) => values[i * size + k])))
  const max = Array.from({ length: size }, (_, k) => Math.max(...Array.from({ length: count }, (_, i) => values[i * size + k])))
  const data = Buffer.alloc(values.length * 2)
  values.forEach((v, i) => {
    const k = i % size
    const range = max[k] - min[k] || 1
    data.writeUInt16LE(Math.max(0, Math.min(65535, Math.floor(((v - min[k]) / range) * 65535))), i * 2)
  })
  return { data, min, max }
}

/** A face with its identical vertices made one, as the uploader does
 *  (`LLVolumeFace::optimize`): the same position, normal and texture
 *  coordinates, to a float's precision. */
function welded(p: Part): Part {
  const seen = new Map<string, number>()
  const out: Part = { material: p.material, positions: [], normals: [], uvs: [], indices: [] }
  const remap: number[] = []
  for (let i = 0; i < p.positions.length / 3; i++) {
    const at = [...p.positions.slice(i * 3, i * 3 + 3), ...p.normals.slice(i * 3, i * 3 + 3), ...p.uvs.slice(i * 2, i * 2 + 2)]
    const k = at.map(Math.fround).join(',')
    let j = seen.get(k)
    if (j === undefined) {
      j = out.positions.length / 3
      seen.set(k, j)
      out.positions.push(...at.slice(0, 3))
      out.normals.push(...at.slice(3, 6))
      out.uvs.push(...at.slice(6))
    }
    remap.push(j)
  }
  out.indices = p.indices.map(i => remap[i])
  return out
}

/** One face as the uploader writes it. */
function face(raw: Part): Buffer {
  const p = welded(raw)
  const pos = quantized(p.positions, 3)
  const uv = quantized(p.uvs, 2)
  const normals = Buffer.alloc(p.normals.length * 2)
  p.normals.forEach((n, i) => normals.writeUInt16LE(Math.max(0, Math.min(65535, Math.floor((n + 1) * 0.5 * 65535))), i * 2))
  const indices = Buffer.alloc(p.indices.length * 2)
  p.indices.forEach((v, i) => indices.writeUInt16LE(v, i * 2))
  return map([
    ['Position', binary(pos.data)], ['Normal', binary(normals)], ['TexCoord0', binary(uv.data)], ['TriangleList', binary(indices)],
    ['PositionDomain', map([['Min', array(pos.min.map(real))], ['Max', array(pos.max.map(real))]])],
    ['TexCoord0Domain', map([['Min', array(uv.min.map(real))], ['Max', array(uv.max.map(real))]])],
  ])
}

/** The compressed size of one level, in bytes. */
export function levelBytes(level: readonly Part[]): number {
  return deflateSync(array(level.map(face)), { level: 9 }).length
}

export interface WeightEstimate {
  /** The download weight by Second Life's arithmetic, before `CALIBRATION`. */
  weight: number
  /** Each level's share of it: high, medium, low, lowest. */
  byLevel: number[]
}

/** A piece's download weight, from its four levels, high first. */
export function downloadWeight(levels: readonly (readonly Part[])[]): WeightEstimate {
  const b = bounds(levels[0] as Part[])
  const radius = Math.hypot(...b.max.map((m, k) => m - b.min[k])) / 2
  const maxArea = 102_944
  const far = (d: number) => Math.min(Math.PI * Math.min(d, 512) ** 2, maxArea)
  const reach = [far(radius / 0.24), far(radius / 0.06), far(radius / 0.03), maxArea]
  const areas = reach.map((a, i) => Math.min(Math.max(a - (i ? reach[i - 1] : 0), 1), maxArea))
  const total = areas.reduce((x, y) => x + y)
  const byLevel = levels.map((level, i) => (Math.max(levelBytes(level) - 384, 16) / 16) * (areas[i] / total) * (15_000 / 250_000))
  return { weight: byLevel.reduce((x, y) => x + y), byLevel }
}

/** The land impact a piece should come to, alone, by the calibration. */
export function estimatedLandImpact(levels: readonly (readonly Part[])[]): number {
  return downloadWeight(levels).weight * CALIBRATION
}
