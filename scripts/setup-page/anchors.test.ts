// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PHASES } from './content'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const GUIDE = 'docs/SELF_HOSTING.md'

/**
 * GitHub's heading-slug rules, as far as this guide exercises them:
 * lowercase, drop everything that is not a letter, digit, space or
 * hyphen, then spaces become hyphens. The em dash in every phase
 * heading is dropped and the spaces either side each become a hyphen,
 * which is why the real anchors carry a double hyphen —
 * `phase-8--wire-bindings-variables-and-secrets`.
 */
export function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .trim()
    .replace(/ /g, '-')
}

function headingSlugs(): Set<string> {
  const text = readFileSync(resolve(REPO_ROOT, GUIDE), 'utf8')
  return new Set(
    [...text.matchAll(/^#{1,3} (.+)$/gm)].map(m => slugify(m[1])),
  )
}

/**
 * Every phase's `anchor` must name a heading that exists.
 *
 * The console links into the guide by anchor — one per phase, rendered
 * as "Full detail in SELF_HOSTING.md ↗" at the foot of each phase card.
 * Nothing checked that the target existed, and `crossCheck` does not:
 * it validates bindings, worksheet ordering and validators, but never
 * opens the Markdown.
 *
 * So renaming a heading silently broke the link. It happened
 * immediately: retitling "Phase 13 — Optional add-ons" to "Conditional
 * and optional extras" left the console pointing at
 * `#phase-13--optional-add-ons`, which GitHub resolves by dumping the
 * reader at the top of a 2,300-line document. The build passed, the
 * page rendered, and the only symptom was a link that goes to the
 * wrong place — which nobody clicks during review.
 *
 * Both ends are drift-prone in different ways: headings get retitled
 * for editorial reasons, and `content.ts` is regenerated wholesale by
 * the design export. Checking one against the other is the only thing
 * that survives either.
 */
describe('console deep-links into the guide', () => {
  it('every phase anchor resolves to a real heading', () => {
    const slugs = headingSlugs()
    const broken = PHASES.filter(p => !slugs.has(p.anchor)).map(
      p => `phase ${p.n} → #${p.anchor}`,
    )
    expect(
      broken,
      `${GUIDE} has no heading matching these anchors — a heading was ` +
        'retitled without updating scripts/setup-page/content.ts',
    ).toEqual([])
  })

  it('anchors are unique, so no two phases share a target', () => {
    const seen = PHASES.map(p => p.anchor)
    expect(new Set(seen).size).toBe(seen.length)
  })

  // A renumber that updates the heading but leaves the old phase
  // number in the anchor resolves fine and lands on the wrong section
  // — the same failure wearing a different hat, and not caught by the
  // existence check above.
  it('each anchor names the phase it belongs to', () => {
    const mismatched = PHASES.filter(p => !p.anchor.startsWith(`phase-${p.n}-`)).map(
      p => `phase ${p.n} → #${p.anchor}`,
    )
    expect(
      mismatched,
      'these anchors point at a different phase than the card they sit on',
    ).toEqual([])
  })

  it('phase numbers are contiguous and ordered', () => {
    const ns = PHASES.map(p => p.n)
    expect(ns, 'PHASES is rendered in array order, so it must be sorted').toEqual(
      [...ns].sort((a, b) => a - b),
    )
    expect(new Set(ns).size, 'two phases share a number').toBe(ns.length)
  })

  // Pins the slug rule itself. If this drifts, the check above starts
  // passing or failing for the wrong reason.
  it('slugifies a phase heading the way GitHub does', () => {
    expect(slugify('Phase 8 — Wire bindings, variables and secrets')).toBe(
      'phase-8--wire-bindings-variables-and-secrets',
    )
    expect(slugify("Phase 7 — Generate your node's secrets")).toBe(
      'phase-7--generate-your-nodes-secrets',
    )
  })
})
