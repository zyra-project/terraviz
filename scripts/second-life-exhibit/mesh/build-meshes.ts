// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Writes the exhibit's mesh pieces as COLLADA files for Second Life's
 * uploader: four levels of detail and a physics shape per piece, into
 * `dae/` beside this script.
 *
 *   npx tsx scripts/second-life-exhibit/mesh/build-meshes.ts          write
 *   npx tsx scripts/second-life-exhibit/mesh/build-meshes.ts --check  compare
 *
 * The files are committed so an owner can download and upload them
 * without a toolchain; `--check` (and `mesh.test.ts`) fail when they no
 * longer match what this script builds.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toCollada, type MaterialColors } from './collada'
import { LOD_NAMES, pieces } from './pieces'

export const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'dae')

/**
 * Preview colours, from the app's tokens. Second Life ignores a COLLADA
 * file's colours on upload; these are for anything else that opens the
 * file, and the dress script paints the real ones in-world.
 */
export const PREVIEW_COLORS: MaterialColors = {
  body: [0.086, 0.094, 0.122],     // #16181f, graphite
  panel: [0.063, 0.071, 0.094],    // #101218
  accent: [0.302, 0.651, 1.0],     // #4da6ff, --color-accent
  cap: [0.114, 0.125, 0.161],      // #1d2029
  ring: [0.204, 0.227, 0.278],     // #343a47
  physics: [0.5, 0.5, 0.5],
}

/** Every file this script writes, by name. */
export function buildFiles(): Map<string, string> {
  const files = new Map<string, string>()
  for (const piece of pieces()) {
    piece.lods.forEach((parts, i) => files.set(`${piece.name}-${LOD_NAMES[i]}.dae`, toCollada(piece.name, parts, PREVIEW_COLORS)))
    files.set(`${piece.name}-physics.dae`, toCollada(`${piece.name}-physics`, piece.physics, PREVIEW_COLORS))
  }
  return files
}

function main(): void {
  const check = process.argv.includes('--check')
  const files = buildFiles()
  if (check) {
    const stale: string[] = []
    for (const [name, text] of files) {
      const path = join(OUT_DIR, name)
      if (!existsSync(path) || readFileSync(path, 'utf8') !== text) stale.push(name)
    }
    const extra = existsSync(OUT_DIR) ? readdirSync(OUT_DIR).filter(f => f.endsWith('.dae') && !files.has(f)) : []
    if (stale.length || extra.length) {
      for (const f of stale) console.error(`out of date: ${f}`)
      for (const f of extra) console.error(`not built by this script: ${f}`)
      console.error('Regenerate: npx tsx scripts/second-life-exhibit/mesh/build-meshes.ts')
      process.exit(1)
    }
    console.log(`${files.size} mesh files up to date`)
    return
  }
  mkdirSync(OUT_DIR, { recursive: true })
  for (const [name, text] of files) writeFileSync(join(OUT_DIR, name), text)
  console.log(`wrote ${files.size} files to ${OUT_DIR}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
