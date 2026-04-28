#!/usr/bin/env node
/**
 * `terraviz` global-install shim.
 *
 * Spawns the TypeScript entry point through `tsx` so users don't
 * need a separate compile step. CommonJS rather than ESM because
 * `npm install -g` symlinks into `${prefix}/bin`, and Node's bin
 * symlink resolution + ESM's strict file-extension rules don't
 * play together cleanly on every platform; a `.cjs` shim with
 * `spawnSync` works everywhere.
 */

'use strict'

const path = require('node:path')
const { spawnSync } = require('node:child_process')

const tsxBin = (() => {
  try {
    return require.resolve('tsx/cli')
  } catch {
    return null
  }
})()

if (!tsxBin) {
  process.stderr.write(
    'terraviz CLI requires `tsx` at runtime. Install with `npm install -g tsx`\n' +
      'or run from a project that has it as a dev dependency.\n',
  )
  process.exit(1)
}

const entry = path.join(__dirname, '..', 'cli', 'terraviz.ts')
const result = spawnSync(process.execPath, [tsxBin, entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
