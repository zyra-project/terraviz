// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string): string => readFileSync(resolve(REPO_ROOT, p), 'utf8')

/** How many datasets `import-snapshot` would actually publish. */
function snapshotSize(): number {
  const raw = JSON.parse(read('public/assets/sos-dataset-list.json')) as {
    datasets: { id: string }[]
  }
  return raw.datasets.length
}

/**
 * The mirror-the-upstream-catalog figure has to resemble the snapshot.
 *
 * It said **~600**. The snapshot holds 204, and live upstream returns
 * the same 204 — the guide was overstating by 3×, in the one sentence
 * an operator uses to decide whether mirroring is worth doing at all.
 *
 * It is written in two places, and the second is why this is a test
 * rather than a one-line fix: `scripts/setup-page/content.ts` is
 * regenerated wholesale by the design export, so a literal there cannot
 * be made drift-proof at the source. That is the same mechanism that
 * let a stale Node version reach a reader in #354, caught the same way
 * — by checking the built artifact rather than trusting the source.
 *
 * Deliberately a band, not an equality. The number is prose, upstream
 * publishes what it publishes, and a test that failed because someone
 * added three datasets would be noise. It fails when the claim stops
 * being approximately true, which is the only failure worth a build.
 */
describe('the documented upstream catalog size', () => {
  const TOLERANCE = 0.4

  const claimed = (text: string): number[] =>
    [...text.matchAll(/(?:about|~)\s*([\d,]{3,})\s+datasets/gi)].map(m =>
      Number(m[1].replace(/,/g, '')),
    )

  for (const path of ['docs/SELF_HOSTING.md', 'scripts/setup-page/content.ts']) {
    it(`${path} states a number close to the snapshot`, () => {
      const actual = snapshotSize()
      const numbers = claimed(read(path))
      expect(numbers.length, `${path} should say how many datasets mirroring gets you`).toBeGreaterThan(0)
      for (const n of numbers) {
        const drift = Math.abs(n - actual) / actual
        expect(
          drift,
          `${path} claims ~${n} datasets; the snapshot holds ${actual}`,
        ).toBeLessThanOrEqual(TOLERANCE)
      }
    })
  }

  // The console is generated from content.ts, and the generated file is
  // what an operator reads. Checking the source only would miss a build
  // that had not been re-run.
  it('reaches the generated install console', () => {
    const actual = snapshotSize()
    const numbers = claimed(read('public/setup.html'))
    expect(numbers.length, 'the console should say how many datasets mirroring gets you').toBeGreaterThan(0)
    for (const n of numbers) {
      expect(
        Math.abs(n - actual) / actual,
        `public/setup.html claims ~${n} datasets; the snapshot holds ${actual} — ` +
          'check scripts/setup-page/content.ts and rebuild',
      ).toBeLessThanOrEqual(TOLERANCE)
    }
  })

  // Not the same as `datasets.length`: `import-snapshot` is idempotent on
  // `legacy_id`, so a repeated id publishes once. Worth pinning, because
  // "about 200" happens to survive either reading and a future exact
  // figure would not.
  it('notes that ids are near-unique, so the published count tracks them', () => {
    const raw = JSON.parse(read('public/assets/sos-dataset-list.json')) as {
      datasets: { id: string }[]
    }
    const unique = new Set(raw.datasets.map(d => d.id)).size
    expect(raw.datasets.length - unique).toBeLessThanOrEqual(5)
  })
})
