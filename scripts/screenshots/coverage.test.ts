// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'

import {
  computeCoverage,
  formatCoverageLine,
  formatCoverageMarkdown,
} from './coverage'

describe('screenshot coverage', () => {
  const enKeys = new Set(['app.title', 'browse.card.load', 'tools.toggle.labels'])

  it('counts covered keys and percent', () => {
    const stats = computeCoverage(
      [['app.title'], ['browse.card.load', 'app.title']],
      enKeys,
    )
    expect(stats.totalKeys).toBe(3)
    expect(stats.coveredKeys).toBe(2)
    expect(stats.percent).toBe(66.7)
    expect(stats.uncovered).toEqual(['tools.toggle.labels'])
  })

  it('flags captured keys not present in en.json', () => {
    const stats = computeCoverage([['app.title', 'ghost.key']], enKeys)
    expect(stats.unknown).toEqual(['ghost.key'])
    // ghost.key is not counted toward coverage of the en surface.
    expect(stats.coveredKeys).toBe(1)
  })

  it('dedupes a key captured across multiple scenes', () => {
    const stats = computeCoverage([['app.title'], ['app.title']], enKeys)
    expect(stats.coveredKeys).toBe(1)
  })

  it('handles an empty en.json without dividing by zero', () => {
    const stats = computeCoverage([['x']], new Set())
    expect(stats.totalKeys).toBe(0)
    expect(stats.percent).toBe(0)
    expect(stats.unknown).toEqual(['x'])
  })

  it('formats a console line and CI markdown', () => {
    const stats = computeCoverage([['app.title']], enKeys)
    expect(formatCoverageLine(stats)).toContain('1/3 keys')
    const md = formatCoverageMarkdown(stats, 4, 17)
    expect(md).toContain('## Weblate screenshot coverage')
    expect(md).toContain('Scenes captured:** 4')
    expect(md).toContain('close-up crops:** 17')
  })
})
