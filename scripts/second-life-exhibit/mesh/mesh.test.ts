// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildFiles, OUT_DIR } from './build-meshes'
import { toCollada } from './collada'
import { bounds, lathe, roundedBox, smoothRun, triangleCount, type Part } from './geometry'
import { GLOBE, KEY, KEY_LAYOUT, LOD_NAMES, PANEL, pieces } from './pieces'

const DRESS = readFileSync(join(__dirname, 'terraviz-dress.lsl'), 'utf8')

/** Every triangle of a part, as three positions and the mean of its stored normals. */
function triangles(p: Part) {
  const v = (i: number) => [p.positions[3 * i], p.positions[3 * i + 1], p.positions[3 * i + 2]]
  const n = (i: number) => [p.normals[3 * i], p.normals[3 * i + 1], p.normals[3 * i + 2]]
  const out = []
  for (let t = 0; t < p.indices.length; t += 3) {
    const [a, b, c] = [p.indices[t], p.indices[t + 1], p.indices[t + 2]]
    out.push({ a: v(a), b: v(b), c: v(c), n: [0, 1, 2].map(k => n(a)[k] + n(b)[k] + n(c)[k]) })
  }
  return out
}
const sub = (a: number[], b: number[]) => a.map((x, i) => x - b[i])
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0)

describe('mesh pieces', () => {
  const all = pieces()

  it('each piece has four levels of detail and one physics shape', () => {
    for (const p of all) {
      expect(p.lods, p.name).toHaveLength(LOD_NAMES.length)
      expect(p.physics.length, p.name).toBeGreaterThan(0)
    }
  })

  it('every level lists the same materials in face order, at most eight', () => {
    // The uploader refuses a model whose levels disagree on materials or
    // their order, and the order is the face numbering the dress script uses.
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

  it('winds every triangle to face the way its normals point', () => {
    // Second Life draws a face from its winding's front only: a quad wound
    // backwards is a hole from outside.
    for (const p of all) for (const part of [...p.lods.flat(), ...p.physics]) {
      for (const t of triangles(part)) expect(dot(cross(sub(t.b, t.a), sub(t.c, t.a)), t.n), `${p.name} ${part.material}`).toBeGreaterThan(0)
    }
  })

  it('maps the texture faces 0..1, so one image fills them', () => {
    for (const p of all) for (const part of p.lods[0]) {
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

  it('keeps every key on the console panel, clear of its neighbours and the edges', () => {
    for (const k of KEY_LAYOUT) {
      const r = KEY.radius * (k.big ? 1.25 : 1)
      expect(Math.abs(k.x) + r, k.id).toBeLessThan(PANEL.sizeX / 2 - 0.02)
      expect(Math.abs(k.y) + r, k.id).toBeLessThan(PANEL.sizeY / 2 - 0.02)
    }
    for (let i = 0; i < KEY_LAYOUT.length; i++) for (let j = i + 1; j < KEY_LAYOUT.length; j++) {
      const a = KEY_LAYOUT[i], b = KEY_LAYOUT[j]
      const ra = KEY.radius * (a.big ? 1.25 : 1), rb = KEY.radius * (b.big ? 1.25 : 1)
      expect(Math.hypot(a.x - b.x, a.y - b.y), `${a.id} / ${b.id}`).toBeGreaterThan(ra + rb + 0.01)
    }
    expect(new Set(KEY_LAYOUT.map(k => k.id)).size).toBe(KEY_LAYOUT.length)
  })
})

describe('geometry builders', () => {
  it('closes a lathe and smooths gentle bends, creasing sharp ones', () => {
    const p = lathe('body', [[0, 0], [1, 0], [1, 1], [0, 1]], 8)
    const b = bounds([p])
    expect(b.min[0]).toBeCloseTo(-1, 5)
    expect(b.max[2]).toBeCloseTo(1, 5)
    // The bottom's normals point down and the side's out: the 90-degree
    // corner keeps its crease.
    expect(p.normals.slice(2, 3)[0]).toBeCloseTo(-1, 5)
  })

  it('makes a plain box with six faces of two triangles at zero segments', () => {
    expect(triangleCount([roundedBox('body', [1, 2, 3], 0.1, 0)])).toBe(12)
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

  it('writes one triangles block per face, in face order, with counts that add up', () => {
    for (const p of pieces()) {
      const text = files.get(`${p.name}-high.dae`)!
      const blocks = [...text.matchAll(/<triangles material="([^"]+)" count="(\d+)">[\s\S]*?<p>([^<]*)<\/p>/g)]
      expect(blocks.map(b => b[1]), p.name).toEqual([...p.faces])
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

  it('writes the same text for the same parts, so a committed file can be compared', () => {
    const p = pieces()[0]
    expect(toCollada(p.name, p.lods[3])).toBe(toCollada(p.name, p.lods[3]))
  })

  it('matches the files committed in dae/', () => {
    // Regenerate with: npx tsx scripts/second-life-exhibit/mesh/build-meshes.ts
    const committed = readdirSync(OUT_DIR).filter(f => f.endsWith('.dae')).sort()
    expect(committed).toEqual([...files.keys()].sort())
    for (const [name, text] of files) expect(readFileSync(join(OUT_DIR, name), 'utf8') === text, name).toBe(true)
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
  it('paints each piece by the face order the generator writes', () => {
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

  it('removes itself once it has painted', () => {
    expect(DRESS).toContain('llRemoveInventory(llGetScriptName());')
  })
})
