// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { PHASES, ADDONS } from './content'

/**
 * A phase card has to say something.
 *
 * The console renders one card per phase: a title, a duration, whatever
 * `intro` and `body` carry, and a gate. When both of those are empty
 * the card is a heading and a gate — which is what shipped for the
 * desktop fork. It claimed "three upstream-pinned values need
 * changing" and named none of them, so the only real content was the
 * link out, and the reader had no way to know what the phase involved
 * before clicking.
 *
 * That happens because cards are written once and their guide sections
 * keep growing. Nothing connected the two, so the drift was invisible
 * until someone screenshotted a card and asked why it was empty.
 *
 * This is deliberately a floor, not a completeness check. A card is a
 * summary and is *supposed* to be shorter than its section; asserting
 * any particular richness would fight the design. Asserting that it is
 * non-empty does not.
 */
describe('phase cards', () => {
  /**
   * Presence is not the bar, and an earlier version of this test learned
   * that the hard way: it asserted a card had an intro *or* a body, and
   * the desktop-fork card passed it — one sentence of intro, no body.
   * The check could not catch the defect it was written for.
   *
   * So it counts rendered words instead. The distribution is not close:
   * the thinnest card that is genuinely fine is Phase 10 at 66 words,
   * and the one that shipped empty was 21. 50 sits between them with
   * room either side, and is a floor rather than a target — a card is a
   * summary and is supposed to be shorter than its section.
   */
  const FLOOR = 50

  const words = (s: string): number => s.split(/\s+/).filter(Boolean).length

  const rendered = (p: (typeof PHASES)[number]): number => {
    let w = (p.intro ?? []).reduce((a, s) => a + words(s), 0)
    for (const b of p.body ?? []) {
      if ('kind' in b) {
        w += words(b.title) + (b.body ?? []).reduce((a, s) => a + words(s), 0)
      } else {
        w += words(b.code)
      }
    }
    w += (p.automatedNote ?? []).reduce((a, s) => a + words(s), 0)
    if (p.automated) w += words(p.automated.code)
    // Phase 14 renders the add-on cards as its content.
    if (p.n === 14) w += ADDONS.reduce((a, x) => a + words(x.body) + words(x.extra ?? ''), 0)
    return w
  }

  it('no card is thinner than the link it sits above', () => {
    const thin = PHASES.filter(p => rendered(p) < FLOOR).map(
      p => `phase ${p.n} (${p.title}): ${rendered(p)} words`,
    )
    expect(
      thin,
      'these render as a heading and a gate — the link out carries the whole payload',
    ).toEqual([])
  })

  // Phases 4, 5 and 9 legitimately open with a trap or note instead of
  // prose — the callout *is* the introduction, and it renders as a
  // full-width box. So an empty `intro` is only a defect when `body` is
  // empty too, which is what the assertion above encodes.
  it('a card that opens on a callout counts as introduced', () => {
    const trapFirst = PHASES.filter(
      p => (p.intro?.length ?? 0) === 0 && (p.body?.length ?? 0) > 0,
    )
    for (const p of trapFirst) {
      expect(p.body![0], `phase ${p.n} opens on something renderable`).toBeTruthy()
    }
  })

  it('every card states what proves the phase worked', () => {
    for (const p of PHASES) {
      expect(p.gate, `phase ${p.n} has no gate`).toBeTruthy()
      expect(p.gateShort, `phase ${p.n} has no gateShort for the print sheet`).toBeTruthy()
    }
  })

  /**
   * The add-on list is rendered whole, not sampled. It used to show
   * four of nine, so the ids read as an arbitrary pair — 13.2 sitting
   * next to 13.7 with nothing between them — and a reader could not
   * tell whether the gaps were features they had missed.
   */
  it('add-on ids are contiguous, so the list cannot look sampled', () => {
    const minor = ADDONS.map(a => Number(a.id.split('.')[1]))
    expect(minor).toEqual(minor.map((_, i) => i + 1))
  })

  it('every add-on says what it takes, not just what it is', () => {
    const silent = ADDONS.filter(a => !a.extra).map(a => `${a.id} ${a.title}`)
    expect(
      silent,
      'a reader deciding whether to spend an afternoon needs the cost, not the pitch',
    ).toEqual([])
  })
})
