// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { transportMeetsInfoPanel } from './playbackController'

/** The info panel in the bottom inline-start corner of the window. */
const INFO = { left: 12, right: 352 }
const GAP = 8

describe('transportMeetsInfoPanel', () => {
  it('is clear on a wide window: the pushed transport stops well short of the panel', () => {
    // 1366 wide, transport resting at the right edge, pushed 420 for the browse panel.
    expect(transportMeetsInfoPanel({ left: 874, right: 1354 }, 0, -420, INFO, GAP)).toBe(false)
  })

  it('meets the panel on a narrow window, where the push carries it across', () => {
    // 1040 wide: resting at 548..1028, pushed to 128..608.
    expect(transportMeetsInfoPanel({ left: 548, right: 1028 }, 0, -420, INFO, GAP)).toBe(true)
  })

  it('judges where the transport will rest, not where it is mid-slide', () => {
    // Half way there (-210 of -420): the box read off the screen is 338..818.
    expect(transportMeetsInfoPanel({ left: 338, right: 818 }, -210, -420, INFO, GAP)).toBe(true)
    // On its way back (push 0), still 100px short of home: it will be clear.
    expect(transportMeetsInfoPanel({ left: 448, right: 928 }, -100, 0, INFO, GAP)).toBe(false)
  })

  it('counts a neighbour closer than the gap as met', () => {
    expect(transportMeetsInfoPanel({ left: 776, right: 1256 }, 0, -420, INFO, GAP)).toBe(true)
    expect(transportMeetsInfoPanel({ left: 782, right: 1262 }, 0, -420, INFO, GAP)).toBe(false)
  })

  it('works mirrored, with the panel at the right and the push to the right', () => {
    const info = { left: 688, right: 1028 }
    expect(transportMeetsInfoPanel({ left: 12, right: 492 }, 0, 420, info, GAP)).toBe(true)
    expect(transportMeetsInfoPanel({ left: 12, right: 492 }, 0, 0, info, GAP)).toBe(false)
  })
})
