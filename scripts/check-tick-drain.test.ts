// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { findDrains } from './check-tick-drain'

const at = (src: string): number[] => findDrains('t.test.ts', src).map(f => f.line)

describe('findDrains', () => {
  it('catches the shape from #364', () => {
    const src = 'for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0))'
    expect(at(src)).toEqual([1])
  })

  it('catches it regardless of count, loop variable, or delay', () => {
    expect(at('for (let n = 0; n < 2; n++) await new Promise(res => setTimeout(res, 5))')).toEqual([1])
    expect(at('while (!done) await new Promise(r => setTimeout(r, 0))')).toEqual([1])
    expect(at('for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 0)) }')).toEqual([1])
  })

  // The single-yield form is deliberately allowed: it lets already-resolved
  // microtasks settle, which is bounded, rather than guessing a count.
  // There are ~100 of them and they are not the flake source.
  it('leaves a single un-looped yield alone', () => {
    expect(at('await new Promise(r => setTimeout(r, 0))')).toEqual([])
    expect(at('await new Promise(r => setTimeout(r, 50))')).toEqual([])
  })

  it('does not flag an ordinary loop', () => {
    expect(at('for (const x of xs) await handle(x)')).toEqual([])
    expect(at('for (let i = 0; i < 3; i++) results.push(i)')).toEqual([])
  })

  it('honours an exemption carrying a reason', () => {
    const src =
      'for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0)) // tick-drain-exempt: measures real elapsed backoff'
    expect(at(src)).toEqual([])
  })

  // Same rule as i18n-exempt / doc-exempt: a bare marker is not an
  // exemption, or the convention becomes a way to silence the check
  // without saying why.
  it('rejects a reasonless exemption', () => {
    const src = 'for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0)) // tick-drain-exempt:'
    expect(at(src)).toEqual([1])
  })

  it('reports every offending line with its number', () => {
    const src = [
      'const a = 1',
      'for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0))',
      'const b = 2',
      'while (x) await new Promise(r => setTimeout(r, 0))',
    ].join('\n')
    expect(at(src)).toEqual([2, 4])
  })
})
