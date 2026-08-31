// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect } from 'vitest'
import {
  buildGlobalTokenSpecs,
  buildPluginCode,
  readGlobalTokensJson,
  GLOBAL_SET_NAME,
} from './sync-penpot-global.ts'

describe('sync-penpot-global', () => {
  const { specs, skipped } = buildGlobalTokenSpecs(readGlobalTokensJson())
  const byName = new Map(specs.map((s) => [s.name, s]))

  it('emits dotted names mirroring the JSON path', () => {
    expect(byName.has('color.accent')).toBe(true)
    expect(byName.has('radius.md')).toBe(true)
    expect(byName.has('accent-opacity.o05')).toBe(true)
    expect(byName.has('white-opacity.o70')).toBe(true)
    expect(byName.has('glass.bg')).toBe(true)
    expect(byName.has('glass.blur')).toBe(true)
    expect(byName.has('touch.min')).toBe(true)
  })

  it('preserves the W3C $type and $value verbatim', () => {
    expect(byName.get('color.accent')).toMatchObject({
      type: 'color',
      value: '#4da6ff',
    })
    expect(byName.get('radius.md')).toMatchObject({
      type: 'dimension',
      value: '6px',
    })
    expect(byName.get('accent-opacity.o05')).toMatchObject({
      type: 'color',
      value: 'rgba(77, 166, 255, 0.05)',
    })
    expect(byName.get('glass.blur')).toMatchObject({
      type: 'dimension',
      value: '12px',
    })
  })

  it('uses the default $value only — ignores mode overrides', () => {
    // radius.lg has a `mobile-native: 10px` override; default is 8px.
    expect(byName.get('radius.lg')?.value).toBe('8px')
    expect(byName.get('radius.xl')?.value).toBe('10px')
    expect(byName.get('touch.min')?.value).toBe('44px')
  })

  it('captures $description when present', () => {
    expect(byName.get('color.accent')?.description).toMatch(/accent/i)
    expect(byName.get('radius.md')?.description).toBeUndefined()
  })

  it('only emits color and dimension specs', () => {
    const types = new Set(specs.map((s) => s.type))
    expect([...types].sort()).toEqual(['color', 'dimension'])
  })

  it('produces unique token names', () => {
    const names = specs.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('plugin code embeds the set name and full spec list', () => {
    const code = buildPluginCode(specs)
    expect(code).toContain(`"setName": "${GLOBAL_SET_NAME}"`)
    expect(code).toContain('"color.accent"')
    expect(code).toContain('"accent-opacity.o05"')
    expect(code).toContain('penpot.library.local.tokens')
    expect(code).toContain('addToken')
    // Sanity: the embedded plan size should match spec count.
    const planMatch = code.match(/"specs": \[([\s\S]*?)\n  \]/)
    expect(planMatch, 'embedded specs array must be present').toBeTruthy()
  })

  it('includes every entry under tokens/global.json that is a color or dimension leaf', () => {
    const SUPPORTED = new Set(['color', 'dimension'])
    function countLeaves(node: unknown): number {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return 0
      const obj = node as Record<string, unknown>
      if ('$type' in obj && '$value' in obj) {
        return SUPPORTED.has(obj.$type as string) ? 1 : 0
      }
      let count = 0
      for (const v of Object.values(obj)) count += countLeaves(v)
      return count
    }
    expect(specs.length + skipped.length).toBe(countLeavesIncludingUnsupported(readGlobalTokensJson()))
    expect(specs.length).toBe(countLeaves(readGlobalTokensJson()))
  })
})

function countLeavesIncludingUnsupported(node: unknown): number {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return 0
  const obj = node as Record<string, unknown>
  if ('$type' in obj && '$value' in obj) return 1
  let count = 0
  for (const v of Object.values(obj)) count += countLeavesIncludingUnsupported(v)
  return count
}
