// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The TerraViz in-world probe: an LSL kit that tests what TerraViz can
 * do inside Second Life, run from a prim and reported in local chat.
 * The results it produced, and what they mean, are
 * `docs/SECOND_LIFE_COMPAT.md` §3–§5; how to run it in-world is
 * `README.md` beside this file.
 *
 * Two scripts go into a prim:
 *
 *   - `terraviz-probe.lsl` serves its own test page onto the prim through
 *     shared media and switches it between modes on chat commands. It is
 *     **generated** from `probe.template.lsl` and `probe.html` (see
 *     `build.ts`), because LSL cannot read a file and the page has to
 *     travel inside the script.
 *   - `node-check.lsl` asks a TerraViz node for data and reports what it
 *     costs a script. Hand-written, and separate so its memory reading
 *     is a lean script's rather than the probe's.
 *
 * Usage:
 *   npx tsx scripts/second-life-probe              # regenerate terraviz-probe.lsl
 *   npx tsx scripts/second-life-probe --check      # fail if it has drifted
 *   npx tsx scripts/second-life-probe --test-page [label]
 *                                                  # run the page through every mode
 *                                                  # (or those whose label starts with one)
 *   npx tsx scripts/second-life-probe --grid <out.png>
 *                                                  # write the labelled grid, for a local texture
 *
 * `build.test.ts` fails CI when the generated script drifts from its
 * sources, so `--check` is for a hand run before pasting. The last two
 * need Playwright's Chromium and load it only when asked.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildProbeScript, servedPage } from './build'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE = join(HERE, 'probe.html')
const TEMPLATE = join(HERE, 'probe.template.lsl')
const SCRIPT = join(HERE, 'terraviz-probe.lsl')

function generated(): string {
  return buildProbeScript(readFileSync(PAGE, 'utf8'), readFileSync(TEMPLATE, 'utf8'))
}

async function main(args: string[]): Promise<number> {
  if (args[0] === '--check') {
    const fresh = generated()
    const committed = readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n')
    if (fresh === committed) {
      console.log('✓ terraviz-probe.lsl matches probe.template.lsl and probe.html')
      return 0
    }
    console.error('terraviz-probe.lsl has drifted from its sources. Run: npx tsx scripts/second-life-probe')
    return 1
  }
  if (args[0] === '--test-page') {
    const { testPage } = await import('./harness')
    return (await testPage(servedPage(readFileSync(SCRIPT, 'utf8')), args[1])) ? 0 : 1
  }
  if (args[0] === '--grid') {
    if (!args[1]) { console.error('usage: --grid <out.png>'); return 2 }
    const { renderGrid } = await import('./harness')
    await renderGrid(servedPage(readFileSync(SCRIPT, 'utf8')), args[1])
    console.log(`wrote ${args[1]}`)
    return 0
  }
  if (args.length > 0) { console.error(`unknown option ${args[0]}`); return 2 }
  writeFileSync(SCRIPT, generated())
  console.log(`wrote ${SCRIPT}`)
  return 0
}

main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
