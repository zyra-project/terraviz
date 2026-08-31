// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * check-tick-drain — reject "wait by counting event-loop turns" in tests.
 *
 * The banned shape is a loop whose body is a zero-delay timer:
 *
 *     for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0))
 *     expect(fetchFn.mock.calls[1][0]).toContain('/asset')
 *
 * The count is a guess about how many turns the async chain needs. On an
 * idle machine it is enough; on a loaded CI runner it sometimes is not,
 * and the assertion fires against a half-finished chain — reported as
 * `Cannot read properties of undefined`, which names neither the race
 * nor what was being waited for. Raising the count moves the threshold
 * instead of removing it, and the failure lands on whichever unrelated
 * PR is open that day, which teaches people to re-run rather than read.
 *
 * Use `until()` from `src/test-utils.ts` and wait for the signal:
 *
 *     await until(() => fetchFn.mock.calls.length >= 2, 'the /asset mint')
 *
 * A slow machine waits longer; a genuinely broken chain still fails, at
 * the timeout, saying what it was waiting for.
 *
 * SCOPE: loops only. A single `await new Promise(r => setTimeout(r, 0))`
 * is left alone — it yields one turn to let already-resolved microtasks
 * settle, which is a different (and bounded) thing from guessing a
 * count. There are ~100 of those and they are not what flakes.
 *
 * Escape hatch, same convention as `i18n-exempt:` / `rtl-exempt:` /
 * `doc-exempt:` — an inline comment on the same line, reason mandatory:
 *
 *     for (...) await new Promise(...)  // tick-drain-exempt: <reason>
 *
 * There are currently zero uses. It exists so that a test which
 * genuinely must bound elapsed time can say so, rather than someone
 * deleting this check.
 *
 * Run via `npm run check:tick-drain` (wired into the type-check chain).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const SCAN_ROOTS = ['src', 'functions', 'cli', 'scripts']

/**
 * This check's own test file, which quotes the banned pattern as string
 * fixtures and would otherwise report itself. Excluded by exact path
 * rather than by a cleverer "is it inside a string literal?" rule,
 * because that needs a parser and would be a second thing to get wrong.
 */
const SELF_TEST = join('scripts', 'check-tick-drain.test.ts')

/** A loop statement whose body awaits a timer. Catches `for`, `for await`
 *  and `while`, any loop variable, any delay — the delay is not the
 *  problem, the counting is. */
const DRAIN = /\b(?:for|while)\s*\([^)]*\)\s*(?:\{\s*)?await\s+new\s+Promise\s*\([^)]*setTimeout/

/** `// tick-drain-exempt: <reason>` on the same line, reason required. */
const EXEMPT = /\/\/[^\n]*tick-drain-exempt:[^\S\n]*\S/

export interface DrainFinding {
  file: string
  line: number
  text: string
}

/** Pure — exported for unit tests. */
export function findDrains(file: string, source: string): DrainFinding[] {
  return source
    .split('\n')
    .map((text, i) => ({ file, line: i + 1, text: text.trim() }))
    .filter(l => DRAIN.test(l.text) && !EXEMPT.test(l.text))
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const abs = join(dir, entry)
    if (statSync(abs).isDirectory()) yield* walk(abs)
    else if (abs.endsWith('.test.ts')) yield abs
  }
}

function main(): void {
  const findings: DrainFinding[] = []
  let scanned = 0
  for (const root of SCAN_ROOTS) {
    const absRoot = join(REPO_ROOT, root)
    try {
      statSync(absRoot)
    } catch {
      continue
    }
    for (const abs of walk(absRoot)) {
      const rel = relative(REPO_ROOT, abs)
      if (rel === SELF_TEST) continue
      scanned++
      findings.push(...findDrains(rel, readFileSync(abs, 'utf8')))
    }
  }

  if (findings.length > 0) {
    console.error('✗ Tests that wait by counting event-loop turns:\n')
    for (const f of findings) {
      console.error(`  ${f.file}:${f.line}`)
      console.error(`    ${f.text}`)
    }
    console.error(
      '\nA tick count is a guess about how long an async chain takes. It holds on\n' +
        'an idle machine and fails on a loaded CI runner, against whichever PR\n' +
        'happens to be open — see issue #364.\n\n' +
        "Wait for the signal instead, with `until()` from `src/test-utils.ts`:\n\n" +
        "    await until(() => fetchFn.mock.calls.length >= 2, 'the /asset mint')\n\n" +
        'If a test genuinely must bound elapsed time, say so on the same line:\n' +
        '    // tick-drain-exempt: <reason>\n',
    )
    process.exit(1)
  }

  console.log(`✓ ${scanned} test file(s) wait on signals, not tick counts.`)
}

// Run only when invoked directly, not when imported by the unit test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
