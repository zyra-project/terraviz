// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The Node version this repo requires, read from `package.json`.
 *
 * ## Why this is a module and not a number
 *
 * It was written out by hand in three places and every one of them was
 * wrong. `engines` said `>=22` and CI ran 22, while the install guide
 * asked for 20 in one section and 20 in another, and the README asked
 * for 18. There is no `.npmrc` with `engine-strict`, so npm warns and
 * carries on — an operator on 18 follows the README, scrolls past a
 * warning, and finds out later and indirectly.
 *
 * Three copies of one fact is not a documentation problem to fix once;
 * it is a drift generator. So the generated surfaces interpolate this,
 * and `node-version.test.ts` fails the build when the hand-written
 * prose in `SELF_HOSTING.md` or `README.md` stops agreeing with
 * `engines`.
 *
 * The floor is deliberately read rather than validated: `engines` is
 * the repo's own declaration and this module reports it, so bumping
 * Node is a one-line change in `package.json` plus whatever prose the
 * test then flags.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * The major version from `engines.node`.
 *
 * Throws rather than guessing: a missing or unparseable `engines` means
 * every surface below would silently print something invented, which is
 * the failure this module exists to prevent.
 */
export function requiredNodeMajor(): number {
  const pkg = JSON.parse(
    readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'),
  ) as { engines?: { node?: string } }
  const raw = pkg.engines?.node
  if (!raw) {
    throw new Error(
      'package.json has no engines.node — the docs derive the required ' +
        'Node version from it, so it cannot be absent.',
    )
  }
  const major = /(\d+)/.exec(raw)?.[1]
  if (!major) {
    throw new Error(`cannot read a major version out of engines.node "${raw}"`)
  }
  return Number(major)
}

/** How the docs and the generated surfaces say it: `22+`. */
export function requiredNodeLabel(): string {
  return `${requiredNodeMajor()}+`
}

/**
 * Where to get it.
 *
 * The official installer rather than a version manager, because the
 * reader this guide is written for — someone standing a node up for a
 * museum or a lab — wants one download that works, not a shell
 * integration. `nvm` is named in the prose for people who already
 * juggle versions; it does not need to be the default.
 */
export const NODE_DOWNLOAD_URL = 'https://nodejs.org/en/download'
