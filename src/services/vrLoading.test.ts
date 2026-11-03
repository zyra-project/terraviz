// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The VR loading scene's subtitle fit. The canvas is a fixed 768 px,
 * and a node's tagline may be 80 characters, so the fit decides
 * whether a long one is cut off at both ends (as it once was),
 * squeezed unreadable, or set on two lines. Measured here with a
 * stand-in that scales with the character count, as a monospace font
 * would: 0.7 em per capital.
 */

import { describe, expect, it } from 'vitest'
import { fitSubtitle } from './vrLoading'

const measure = (text: string, px: number): number => text.length * px * 0.7
const MAX = 768 - 64

describe('fitSubtitle', () => {
  it('keeps the default on one line at full size', () => {
    expect(fitSubtitle('SCIENCE ON A SPHERE', measure)).toEqual({
      lines: ['SCIENCE ON A SPHERE'],
      px: 32,
      squeeze: false,
    })
  })

  it('shrinks a line that is a little too long rather than wrapping it', () => {
    const text = 'NOAA GLOBAL MONITORING LABORATORY' // 33 capitals: 739 px at 32
    const layout = fitSubtitle(text, measure)
    expect(layout.lines).toEqual([text])
    expect(layout.px).toBeLessThan(32)
    expect(measure(text, layout.px)).toBeLessThanOrEqual(MAX)
  })

  it('wraps a long tagline onto two balanced lines that fit', () => {
    const text = 'A RATHER LONGER TAGLINE FOR A NODE RUN BY A CONSORTIUM OF LABS'
    const layout = fitSubtitle(text, measure)
    expect(layout.lines).toHaveLength(2)
    expect(layout.lines.join(' ')).toBe(text)
    expect(layout.squeeze).toBe(false)
    for (const line of layout.lines) expect(measure(line, layout.px)).toBeLessThanOrEqual(MAX)
    const [a, b] = layout.lines.map(line => line.length)
    expect(Math.abs(a - b)).toBeLessThan(12)
  })

  it('squeezes only what no size fits', () => {
    const word = 'X'.repeat(80)
    expect(fitSubtitle(word, measure)).toMatchObject({ lines: [word], squeeze: true })
    // Only one place to break, and the long side overflows at any size.
    const lopsided = `${'X'.repeat(60)} ${'X'.repeat(19)}`
    expect(fitSubtitle(lopsided, measure)).toMatchObject({ lines: ['X'.repeat(60), 'X'.repeat(19)], squeeze: true })
  })

  it('sets the longest tagline the profile accepts on two lines without squeezing', () => {
    const eighty = Array.from({ length: 16 }, () => 'WWWW').join(' ') // 79 characters
    expect(fitSubtitle(eighty, measure)).toMatchObject({ squeeze: false })
    expect(fitSubtitle(eighty, measure).lines).toHaveLength(2)
  })
})
