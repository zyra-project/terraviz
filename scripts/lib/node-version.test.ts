// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requiredNodeMajor, requiredNodeLabel, NODE_DOWNLOAD_URL } from './node-version'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (p: string): string => readFileSync(resolve(REPO_ROOT, p), 'utf8')

describe('requiredNodeMajor', () => {
  it('reads the major out of engines.node', () => {
    expect(requiredNodeMajor()).toBeGreaterThanOrEqual(18)
    expect(requiredNodeLabel()).toBe(`${requiredNodeMajor()}+`)
  })
})

/**
 * The prose has to agree with `engines`.
 *
 * This is the check that would have caught the state this was written
 * in: `engines` said 22, CI ran 22, the install guide asked for 20
 * twice, and the README asked for 18. Nothing failed, because npm only
 * warns without `engine-strict` — so the docs were free to drift and
 * did, in three different directions.
 *
 * Matching on "Node.js <n>" rather than on an exact sentence keeps
 * this from being a prose lint: rewrite the sentences freely, just do
 * not name a version the repo does not require.
 */
describe('the documented Node version', () => {
  const docs = [
    'docs/SELF_HOSTING.md',
    'README.md',
    'docs/CATALOG_BACKEND_DEVELOPMENT.md',
  ]

  for (const path of docs) {
    it(`${path} names no Node version other than engines'`, () => {
      const major = requiredNodeMajor()
      const text = read(path)
      // Catches every shape the four stale claims used: "Node.js 20+",
      // "Node.js 18+", "Node.js ≥ 20.10" and a bare "Node 22".
      const named = [...text.matchAll(/Node(?:\.js)?\s*(?:[≥>=v]+\s*)?(\d{2})/gi)].map(
        m => Number(m[1]),
      )
      for (const n of named) {
        expect(n, `${path} asks for Node ${n}, engines requires ${major}`).toBe(major)
      }
    })
  }

  it('tells the reader where to get it', () => {
    expect(read('docs/SELF_HOSTING.md')).toContain(NODE_DOWNLOAD_URL)
  })

  // The sheet is the surface an operator prints, and it runs `npm` at
  // step 6 — it cannot be the one document that never mentions Node.
  it('reaches the generated install console', () => {
    const page = read('public/setup.html')
    expect(page).toContain(`Node.js ${requiredNodeLabel()}`)
    expect(page).toContain(NODE_DOWNLOAD_URL)
  })

  // Presence is not enough, and this is why: the first version of this
  // test only asserted the page *contained* "Node.js 22+", so a stale
  // `node --version # must be >= 20` in content.ts sailed through and
  // reached a reader. `content.ts` is replaced wholesale by the design
  // export, so its literal cannot be made drift-proof at the source —
  // catching it in the built page is the mechanism that survives.
  it('names no other version anywhere in the built page', () => {
    const major = requiredNodeMajor()
    const page = read('public/setup.html')
    // Two plain patterns over entity-decoded text, rather than one that
    // tries to absorb `&gt;=` inline. The combined version alternated
    // `&gt;=` against a class that could also match it character by
    // character, under a `*` — two ways to match the same input, which
    // is exponential backtracking and what CodeQL flagged. These are
    // literals plus a digit class: linear, and easier to read.
    const decoded = page.replace(/&gt;/g, '>')
    const named = [
      ...decoded.matchAll(/Node(?:\.js)?\s+v?(\d{2})/gi),
      ...decoded.matchAll(/must be >=\s*(\d{2})/gi),
    ].map(m => Number(m[1]))
    expect(named.length, 'the page should say which Node it needs').toBeGreaterThan(0)
    for (const n of named) {
      expect(
        n,
        `public/setup.html names Node ${n}, engines requires ${major} — check scripts/setup-page/content.ts`,
      ).toBe(major)
    }
  })
})

/**
 * The one dependency that compiles.
 *
 * `better-sqlite3` is the only package in the tree with a
 * `binding.gyp`, and it installs via `prebuild-install || node-gyp
 * rebuild`. When a precompiled binary exists for your Node, that is a
 * download. When it does not, it is a source build, and a source build
 * needs Python and a C++ compiler that an operator standing up a museum
 * node has no reason to have.
 *
 * This is not hypothetical. The guide said "install the LTS build from
 * nodejs.org", nodejs.org handed over Node 24, and the pinned
 * `better-sqlite3@11.10.0` had no Node 24 binary — so `npm install`
 * died inside node-gyp hunting for a Python interpreter. The error
 * names Python, which sends people off to install Python; the cause is
 * three lines higher, in a `prebuild-install warn` nobody reads.
 *
 * `11.10.0` declared no `engines` at all, so there was nothing to check
 * and nothing did. From `12.x` there is. The floor alone is not the
 * interesting assertion — `floor + 2` is, because that is the major
 * nodejs.org will be offering as LTS by the time someone follows this
 * guide, and it is the one that was missing.
 *
 * Caveat worth knowing before trusting this: a declared `engines` range
 * is a claim about source compatibility, not a promise that a binary
 * was published. Measured against the actual release assets, `12.11.1`
 * declares `20.x || 22.x || 23.x || 24.x || 25.x || 26.x` and publishes
 * binaries for 22, 24 and 25 — identically on win32, linux and darwin.
 * So this check is a floor, not a guarantee: it catches the dependency
 * falling behind the Node the guide names, which is what happened, and
 * it cannot catch a major that is declared but never built.
 *
 * That gap is also why the guide names 22 and 24 outright instead of
 * describing a rule. The published set is "whatever was current when
 * this version shipped" — 20 and 23 are gone for being end-of-life, 26
 * is missing for being newer than the release. Any rule short enough to
 * put in an install guide gets that wrong within a year.
 */
describe('the native dependency', () => {
  const engines = (
    JSON.parse(read('node_modules/better-sqlite3/package.json')) as {
      engines?: { node?: string }
    }
  ).engines?.node

  const majors = (range: string): number[] =>
    [...range.matchAll(/(\d+)\.x/g)].map(m => Number(m[1]))

  it('declares which Node majors it supports', () => {
    expect(
      engines,
      'better-sqlite3 stopped declaring engines.node — this check is now blind',
    ).toBeTruthy()
    expect(majors(engines ?? '').length).toBeGreaterThan(0)
  })

  it('covers the Node this repo requires, and the next LTS after it', () => {
    const floor = requiredNodeMajor()
    const supported = majors(engines ?? '')
    for (const wanted of [floor, floor + 2]) {
      expect(
        supported,
        `better-sqlite3 supports ${supported.join(', ')} but the guide sends ` +
          `operators to Node ${wanted}, where npm install would fall back to ` +
          `a source build. Bump better-sqlite3, or stop naming that version.`,
      ).toContain(wanted)
    }
  })
})
