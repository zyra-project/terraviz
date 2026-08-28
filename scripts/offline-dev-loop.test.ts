// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string): string => readFileSync(resolve(REPO_ROOT, p), 'utf8')

/**
 * `npm run dev:functions` has to work on a fresh clone.
 *
 * Wrangler opens an authenticated *remote* proxy session for a
 * Workers AI binding before `pages dev` serves anything. Every other
 * binding in `wrangler.toml` runs local — D1, KV, R2 and Analytics
 * Engine are all provisioned under `.wrangler/` — so a single `[ai]`
 * block was the difference between a contributor being able to run
 * the backend and not, regardless of `MOCK_AI=true`.
 *
 * The obvious repair does not exist: `experimental_remote = false`
 * leaves the binding in remote mode, `remote = false` reports it as
 * "not supported" and opens the session anyway, and `pages dev`
 * rejects `--config`. So the declaration cannot stay.
 *
 * That makes this a standing invariant rather than a one-time fix.
 * `AI` is a real production binding — the Orbit chat proxy, voice,
 * embeddings, event enrichment and blog drafting all call `env.AI` —
 * so the natural instinct is to declare it here for the same
 * documentation reason every other block is declared. Doing that
 * re-breaks the offline loop silently: the failure lands on the next
 * person to clone, not on whoever adds the block. The deploy-time
 * contract lives in `scripts/lib/expected-bindings.ts`, which
 * `npm run check:pages-bindings` audits against the real project.
 */
describe('the offline dev loop', () => {
  it('wrangler.toml declares no AI binding', () => {
    const offending = read('wrangler.toml')
      .split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /^\[ai\]/.test(line))

    expect(
      offending,
      'An [ai] binding makes `wrangler pages dev` require Cloudflare credentials, ' +
        'which breaks `npm run dev:functions` on a fresh clone. Wire AI in the Pages ' +
        'dashboard and record it in scripts/lib/expected-bindings.ts instead; use ' +
        '`npm run dev:functions:ai` to exercise it locally.',
    ).toEqual([])
  })

  // Removing the block without leaving a way back would trade one
  // broken path for another: with no binding at all there is no way
  // to exercise Orbit chat, voice or live embeddings against the real
  // service. `--ai AI` restores exactly the binding the block did —
  // verified by the dev-server binding table reporting `env.AI … remote`
  // either way.
  it('keeps an opt-in script that passes the binding on the command line', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    const optIn = Object.entries(pkg.scripts).filter(([, cmd]) => /--ai(\s|=)/.test(cmd))

    expect(optIn.length, 'no script passes --ai, so real Workers AI is unreachable locally')
      .toBeGreaterThan(0)

    // The name has to match what the handlers read off `env`.
    for (const [name, cmd] of optIn) {
      expect(cmd, `${name} must bind the name the Functions read (env.AI)`).toMatch(
        /--ai[\s=]AI(\s|$)/,
      )
    }
  })

  // content.ts is regenerated wholesale by the design export, so a
  // literal there cannot be made drift-proof at the source — the same
  // mechanism that let a stale Node version and a 3×-wrong dataset
  // count reach readers. Checking the built page too is what makes
  // this catch a regeneration that dropped the opt-in.
  for (const path of [
    'README.md',
    'docs/SELF_HOSTING.md',
    'scripts/setup-page/content.ts',
    'public/setup.html',
  ]) {
    it(`${path} points at the opt-in rather than at editing the config`, () => {
      const text = read(path)

      expect(text, `${path} should tell the reader how to reach real Workers AI`).toMatch(
        /dev:functions:ai/,
      )
      expect(
        text,
        `${path} still tells the reader to comment out an [ai] block that is no longer there`,
      ).not.toMatch(/comment(ing)? out\s+(the\s+)?`?\[ai\]/i)
    })
  }
})
