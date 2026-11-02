// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildFiles, OUT_DIR } from './build-meshes'
import { faceName, toCollada } from './collada'
import { bounds, filletOutline, lathe, roundedBox, smoothRun, triangleCount, type Part } from './geometry'
import { BLADE, GLOBE, KEY, KEY_LAYOUT, LOD_NAMES, PANEL, pieces } from './pieces'
import { downloadWeight, estimatedLandImpact, levelBytes } from './weights'

const DRESS = readFileSync(join(__dirname, 'terraviz-dress.lsl'), 'utf8')

/** Every triangle of a part, as three positions. */
function triangles(p: Part) {
  const v = (i: number) => [p.positions[3 * i], p.positions[3 * i + 1], p.positions[3 * i + 2]]
  const out = []
  for (let t = 0; t < p.indices.length; t += 3) out.push({ a: v(p.indices[t]), b: v(p.indices[t + 1]), c: v(p.indices[t + 2]) })
  return out
}
const sub = (a: number[], b: number[]) => a.map((x, i) => x - b[i])
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0)

/**
 * A level's triangles with their corners welded by position (to a
 * micrometre), so faces of different materials that share a seam share
 * its vertices.
 */
function weld(parts: readonly Part[]) {
  const ids = new Map<string, number>()
  const points: number[][] = []
  const tris: number[][] = []
  for (const p of parts) for (const t of triangles(p)) {
    tris.push([t.a, t.b, t.c].map(v => {
      const key = v.map(x => Math.round(x * 1e6)).join(',')
      if (!ids.has(key)) { ids.set(key, points.length); points.push(v) }
      return ids.get(key)!
    }))
  }
  return { points, tris }
}

/** The connected shells a welded level falls into, as lists of triangle indices. */
function shells(tris: readonly number[][]): number[][] {
  const parent = new Map<number, number>()
  const find = (x: number): number => {
    while (parent.has(x) && parent.get(x) !== x) x = parent.get(x)!
    return x
  }
  for (const [a, b, c] of tris) for (const v of [b, c]) {
    const [ra, rv] = [find(a), find(v)]
    parent.set(ra, ra); parent.set(rv, ra)
  }
  const groups = new Map<number, number[]>()
  tris.forEach((t, i) => {
    const r = find(t[0])
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r)!.push(i)
  })
  return [...groups.values()]
}

describe('mesh pieces', () => {
  const all = pieces()

  it('each piece has four levels of detail and one physics shape', () => {
    for (const p of all) {
      expect(p.lods, p.name).toHaveLength(LOD_NAMES.length)
      expect(p.physics.length, p.name).toBeGreaterThan(0)
    }
  })

  it('every level lists the same materials in face order, at most eight', () => {
    // The uploader matches each lower level to the high one by material
    // name, and Second Life takes at most eight faces.
    for (const p of all) {
      expect(p.faces.length, p.name).toBeLessThanOrEqual(8)
      for (const lod of p.lods) expect(lod.map(x => x.material), p.name).toEqual([...p.faces])
    }
  })

  it('each level is no heavier than the one before, and physics stays tiny', () => {
    for (const p of all) {
      const counts = p.lods.map(triangleCount)
      for (let i = 1; i < counts.length; i++) expect(counts[i], `${p.name} ${LOD_NAMES[i]}`).toBeLessThan(counts[i - 1])
      expect(counts[0], p.name).toBeLessThan(5000)
      expect(triangleCount(p.physics), p.name).toBeLessThanOrEqual(64)
    }
  })

  it('gives every level and the physics shape the bounding box of the high level', () => {
    // The uploader scales each model to fill its own bounding box, then
    // stretches it over the high level's: a level a few millimetres
    // narrower is drawn a few millimetres wider than it was built. The
    // console's low levels round its tilted panel more coarsely and come
    // 1.4 mm short; 0.3% allows that and nothing visible.
    for (const p of all) {
      const hi = bounds(p.lods[0])
      ;[...p.lods, p.physics].forEach((parts, i) => {
        const b = bounds(parts)
        for (let k = 0; k < 3; k++) {
          const allow = 0.003 * (hi.max[k] - hi.min[k])
          const label = `${p.name} ${LOD_NAMES[i] ?? 'physics'} axis ${'XYZ'[k]}`
          expect(Math.abs(b.min[k] - hi.min[k]), label).toBeLessThanOrEqual(allow)
          expect(Math.abs(b.max[k] - hi.max[k]), label).toBeLessThanOrEqual(allow)
        }
      })
    }
  })

  it('has finite positions, unit normals, in-range indices and no flat triangles', () => {
    for (const p of all) for (const part of [...p.lods.flat(), ...p.physics]) {
      expect(part.positions.every(Number.isFinite), p.name).toBe(true)
      for (let i = 0; i < part.normals.length; i += 3) {
        expect(Math.hypot(part.normals[i], part.normals[i + 1], part.normals[i + 2]), p.name).toBeCloseTo(1, 3)
      }
      const count = part.positions.length / 3
      expect(part.indices.every(i => i >= 0 && i < count), p.name).toBe(true)
      expect(part.uvs.length / 2, p.name).toBe(count)
      for (const t of triangles(part)) expect(Math.hypot(...cross(sub(t.b, t.a), sub(t.c, t.a))), p.name).toBeGreaterThan(1e-12)
    }
  })

  it('closes every level into shells wound outward', () => {
    // Second Life draws a triangle from the side its winding calls the
    // front, so one wound inward is a hole seen from outside. Every edge
    // met exactly once in each direction means every face agrees with its
    // neighbours, across materials, which side is out; each shell
    // enclosing positive volume means out is outward.
    for (const p of all) [...p.lods, p.physics].forEach((parts, i) => {
      const label = `${p.name} ${LOD_NAMES[i] ?? 'physics'}`
      const { points, tris } = weld(parts)
      const directed = new Map<string, number>()
      for (const [a, b, c] of tris) for (const [u, v] of [[a, b], [b, c], [c, a]]) directed.set(`${u} ${v}`, (directed.get(`${u} ${v}`) ?? 0) + 1)
      const unpaired = [...directed].filter(([e, n]) => n !== 1 || directed.get(e.split(' ').reverse().join(' ')) !== 1)
      expect(unpaired.length, `${label}: edges not met once each way`).toBe(0)
      for (const shell of shells(tris)) {
        const volume = shell.reduce((s, t) => s + dot(points[tris[t][0]], cross(points[tris[t][1]], points[tris[t][2]])) / 6, 0)
        expect(volume, label).toBeGreaterThan(0)
      }
    })
  })

  it('maps the texture faces 0..1 at every level, so one image fills them', () => {
    for (const p of all) for (const lod of p.lods) for (const part of lod) {
      if (part.material !== 'panel' && part.material !== 'cap') continue
      expect(Math.min(...part.uvs), p.name).toBeGreaterThanOrEqual(-1e-9)
      expect(Math.max(...part.uvs), p.name).toBeLessThanOrEqual(1 + 1e-9)
    }
  })

  it('sizes the stem to put its cup just under the globe', () => {
    const stem = all.find(p => p.name === 'terraviz-stem')!
    const b = bounds(stem.lods[0])
    expect(b.min[2]).toBeCloseTo(0, 5)
    expect(b.max[2]).toBeGreaterThan(GLOBE.bottom - 0.03)
    expect(b.max[2]).toBeLessThan(GLOBE.bottom)
  })

  it('runs the blade up into the panel, so no gap shows beneath it', () => {
    // Each corner of the blade's top, taken into the tilted panel's own
    // frame, sits inside the panel's slab with room to spare, under its
    // flat top rather than its rounded edges.
    const c = Math.cos(PANEL.tilt), s = Math.sin(PANEL.tilt)
    const top = Math.max(...BLADE.outline.map(q => q[1]))
    const corners = BLADE.outline.filter(q => q[1] === top)
    expect(corners).toHaveLength(2)
    for (const x of [-BLADE.depth / 2, BLADE.depth / 2]) for (const [y, z] of corners) {
      const dz = z - PANEL.height
      const along = x * c - dz * s, across = x * s + dz * c
      expect(Math.abs(across), `${x} ${y}`).toBeLessThan(PANEL.thickness / 2 - 0.003)
      expect(Math.abs(along), `${x} ${y}`).toBeLessThan(PANEL.sizeX / 2 - PANEL.radius)
      expect(Math.abs(y), `${x} ${y}`).toBeLessThan(PANEL.sizeY / 2 - PANEL.radius)
    }
  })

  it('keeps every key on the console panel, clear of its neighbours and the edges', () => {
    for (const k of KEY_LAYOUT) {
      const r = KEY.radius * (k.big ? 1.25 : 1)
      expect(Math.abs(k.x) + r, k.id).toBeLessThan(PANEL.sizeX / 2 - PANEL.radius)
      expect(Math.abs(k.y) + r, k.id).toBeLessThan(PANEL.sizeY / 2 - PANEL.radius)
    }
    for (let i = 0; i < KEY_LAYOUT.length; i++) for (let j = i + 1; j < KEY_LAYOUT.length; j++) {
      const a = KEY_LAYOUT[i], b = KEY_LAYOUT[j]
      const ra = KEY.radius * (a.big ? 1.25 : 1), rb = KEY.radius * (b.big ? 1.25 : 1)
      expect(Math.hypot(a.x - b.x, a.y - b.y), `${a.id} / ${b.id}`).toBeGreaterThan(ra + rb + 0.01)
    }
    expect(new Set(KEY_LAYOUT.map(k => k.id)).size).toBe(KEY_LAYOUT.length)
  })
})

describe('land impact', () => {
  // Estimates (weights.ts), calibrated against the pieces uploaded on 28
  // October 2026, which came in at 6, 8, 6 and 1 before their lower
  // levels were thinned. A budget broken here is a level grown heavier
  // than the distance it is seen from needs.
  const BUDGET: Record<string, number> = { 'terraviz-stem': 3.5, 'terraviz-plinth': 3.5, 'terraviz-console': 2, 'terraviz-key': 0.75 }

  it('keeps each piece within its budget', () => {
    for (const p of pieces()) {
      expect(BUDGET[p.name], p.name).toBeDefined()
      expect(estimatedLandImpact(p.lods), p.name).toBeLessThanOrEqual(BUDGET[p.name])
    }
  })

  it('charges a small piece for its lowest level, and a large one for its lower levels', () => {
    const [stem, plinth, , key] = pieces()
    const share = (p: typeof key, i: number) => { const e = downloadWeight(p.lods); return e.byLevel[i] / e.weight }
    // A key's lowest shows from about 2 m away, the stem's from 25 m.
    expect(share(key, 3)).toBeGreaterThan(0.99)
    expect(share(stem, 3)).toBeGreaterThan(0.75)
    // The plinth's medium and low levels show out to 100 m.
    expect(share(plinth, 3)).toBeLessThan(0.5)
  })

  it('counts a level by its compressed size, so more triangles cost more', () => {
    const [stem] = pieces()
    expect(levelBytes(stem.lods[0])).toBeGreaterThan(levelBytes(stem.lods[3]))
    // A heavier lowest costs more, all else the same.
    const heavier = downloadWeight([stem.lods[0], stem.lods[1], stem.lods[2], stem.lods[1]]).weight
    expect(heavier).toBeGreaterThan(downloadWeight(stem.lods).weight)
  })
})

describe('geometry builders', () => {
  it('smooths a gentle bend in a lathe and keeps a sharp one creased', () => {
    // A right angle at (1, 0); about six degrees at (1, 1).
    const p = lathe('body', [[0, 0], [1, 0], [1, 1], [0.9, 2], [0, 2]], 8)
    const normalsAt = (x: number, z: number) => {
      const found = new Set<string>()
      for (let i = 0; i < p.positions.length; i += 3) {
        if (Math.abs(p.positions[i] - x) < 1e-9 && Math.abs(p.positions[i + 1]) < 1e-9 && Math.abs(p.positions[i + 2] - z) < 1e-9) {
          found.add([p.normals[i], p.normals[i + 1], p.normals[i + 2]].map(n => Math.round(n * 1e6) / 1e6).join(','))
        }
      }
      return [...found]
    }
    expect(normalsAt(1, 0).sort()).toEqual(['0,0,-1', '1,0,0'])
    const gentle = normalsAt(1, 1)
    expect(gentle).toHaveLength(1)
    const [nx, , nz] = gentle[0].split(',').map(Number)
    expect(nx).toBeGreaterThan(0.99)
    expect(nz).toBeGreaterThan(0.01)
  })

  it('makes a plain box with six faces of two triangles at zero segments', () => {
    expect(triangleCount([roundedBox('body', [1, 2, 3], 0.1, 0)])).toBe(12)
  })

  it('leaves just the flat middle of a rounded box top open when asked', () => {
    const closed = triangleCount([roundedBox('body', [1, 1, 1], 0.1, 2)])
    expect(triangleCount([roundedBox('body', [1, 1, 1], 0.1, 2, true)])).toBe(closed - 2)
    expect(triangleCount([roundedBox('body', [1, 1, 1], 0.1, 0, true)])).toBe(10)
  })

  it('keeps a corner given no fillet sharp', () => {
    const square = [[0, 0], [1, 0], [1, 1], [0, 1]] as const
    const out = filletOutline(square, [0.1, 0.1, 0, 0], 2)
    expect(out).toHaveLength(3 + 3 + 1 + 1)
    expect(out).toContainEqual([1, 1])
    expect(out).toContainEqual([0, 1])
    expect(out).not.toContainEqual([0, 0])
  })

  it('keeps a smooth run passing through its first and last points', () => {
    const run = smoothRun([[0, 0], [1, 1], [2, 0], [3, 1]], 4)
    expect(run[0]).toEqual([0, 0])
    expect(run[run.length - 1]).toEqual([3, 1])
    expect(run).toHaveLength(3 * 4 + 1)
  })
})

describe('COLLADA files', () => {
  const files = buildFiles()
  const faceNames = (text: string) => [...text.matchAll(/<triangles material="([^"]+)"/g)].map(m => m[1])

  it('names the faces so the alphabetical sort Second Life applies keeps their order', () => {
    // The viewer sorts a model's faces by material name, ignoring case
    // (LLModel::sortVolumeFacesByMaterialName), and numbers them in that
    // order; the dress script paints by those numbers.
    const insensitive = (a: string, b: string) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0)
    for (const [file, text] of files) {
      const names = faceNames(text)
      expect(names, file).toEqual([...names].sort(insensitive))
    }
    for (const p of pieces()) for (const lod of LOD_NAMES) {
      expect(faceNames(files.get(`${p.name}-${lod}.dae`)!), `${p.name} ${lod}`).toEqual(p.faces.map((f, i) => faceName(i, f)))
    }
  })

  it('writes one triangles block per face, with counts that add up', () => {
    for (const p of pieces()) {
      const text = files.get(`${p.name}-high.dae`)!
      const blocks = [...text.matchAll(/<triangles material="([^"]+)" count="(\d+)">[\s\S]*?<p>([^<]*)<\/p>/g)]
      expect(blocks, p.name).toHaveLength(p.faces.length)
      const positions = text.match(/<float_array id="[^"]+-positions-array" count="(\d+)">([^<]*)</)!
      const vertexCount = Number(positions[1]) / 3
      expect(positions[2].trim().split(/\s+/)).toHaveLength(Number(positions[1]))
      for (const b of blocks) {
        const idx = b[3].trim().split(/\s+/).map(Number)
        expect(idx.length, p.name).toBe(Number(b[2]) * 3 * 3)
        expect(Math.max(...idx), p.name).toBeLessThan(vertexCount)
      }
      expect(text, p.name).toContain('<up_axis>Z_UP</up_axis>')
      expect(text, p.name).toContain('<unit name="meter" meter="1"/>')
    }
  })

  it('refuses a model with more faces than Second Life takes', () => {
    const parts = Array.from({ length: 9 }, (_, i) => ({ material: `m${i}`, positions: [], normals: [], uvs: [], indices: [] }))
    expect(() => toCollada('too-many', parts)).toThrow(/at most 8/)
  })

  it('writes the same text for the same parts, so a committed file can be compared', () => {
    const p = pieces()[0]
    expect(toCollada(p.name, p.lods[3])).toBe(toCollada(p.name, p.lods[3]))
  })

  it('matches the files committed in dae/', () => {
    // Regenerate with: npx tsx scripts/second-life-exhibit/mesh/build-meshes.ts
    // Line endings are set aside: a Windows checkout may have rewritten them.
    const committed = readdirSync(OUT_DIR).filter(f => f.endsWith('.dae')).sort()
    expect(committed).toEqual([...files.keys()].sort())
    for (const [name, text] of files) {
      expect(readFileSync(join(OUT_DIR, name), 'utf8').replace(/\r\n/g, '\n') === text, name).toBe(true)
    }
  })
})

describe('README', () => {
  it('states the real size, faces and triangle counts of each piece', () => {
    const readme = readFileSync(join(__dirname, 'README.md'), 'utf8')
    for (const p of pieces()) {
      const row = readme.split('\n').find(l => l.startsWith(`| \`${p.name}\``))
      expect(row, p.name).toBeDefined()
      const b = bounds(p.lods[0])
      const size = b.max.map((m, i) => (m - b.min[i]).toFixed(3)).join(' × ')
      expect(row, p.name).toContain(size)
      expect(row, p.name).toContain(p.faces.map((f, i) => `${i} ${f}`).join(', '))
      expect(row, p.name).toContain(p.lods.map(triangleCount).join(' / '))
    }
  })
})

describe('terraviz-dress.lsl', () => {
  it('paints each piece by its face numbers', () => {
    const table = DRESS.match(/list FACES = \[([\s\S]*?)\];/)![1]
    const strings = [...table.matchAll(/"([^"]*)"/g)].map(m => m[1])
    const fromScript = new Map<string, string[]>()
    for (let i = 0; i < strings.length; i += 2) fromScript.set(strings[i], strings[i + 1].split(' '))
    const ps = pieces()
    expect([...fromScript.keys()].sort()).toEqual(ps.map(p => p.name).sort())
    for (const p of ps) expect(fromScript.get(p.name), p.name).toEqual([...p.faces])
  })

  it('knows every material a piece uses', () => {
    const known = new Set(['body', ...[...DRESS.matchAll(/material == "([a-z]+)"/g)].map(m => m[1])])
    for (const p of pieces()) for (const f of p.faces) expect(known.has(f), `${p.name} ${f}`).toBe(true)
  })

  it('lights nothing at rest', () => {
    // docs/SECOND_LIFE_COMPAT.md §9 Phase 5: glow only where something is
    // live or pressed. The console script lights a key's ring when pressed.
    const glows = [...DRESS.matchAll(/PRIM_GLOW, face, ([^,\]]+)/g)].map(m => m[1].trim())
    expect(glows.length).toBeGreaterThan(0)
    for (const g of glows) expect(g).toBe('0.0')
  })

  it('removes itself once it has painted', () => {
    expect(DRESS).toContain('llRemoveInventory(llGetScriptName());')
  })
})
