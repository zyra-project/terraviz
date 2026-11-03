// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The loading-screen tagline's character rules. What is refused is
 * what makes the stored text differ from what a reviewer sees, or
 * lets it break out of one line; what is kept is what real scripts
 * need.
 */

import { describe, expect, it } from 'vitest'
import { cleanTaglineInput, hasOnlyTaglineChars } from './node-tagline'

describe('hasOnlyTaglineChars', () => {
  it('accepts ordinary text in any script', () => {
    for (const ok of [
      'Global Systems Laboratory',
      'Laboratorio de Sistemas Globales',
      'مختبر الأنظمة العالمية',
      'मौसम\u200Dविज्ञान', // ZWJ, which Indic scripts need
      'می\u200Cخواهم', // ZWNJ, which Persian needs
      'abc \u200F def', // RLM, which right-to-left text uses
    ]) {
      expect(hasOnlyTaglineChars(ok)).toBe(true)
    }
  })

  it('refuses controls, line separators, bidi overrides and invisible characters', () => {
    for (const bad of [
      'a\tb',
      'a\nb',
      'a\u0085b',
      'a\u2028b',
      'a\u2029b',
      'a\u202Eb',
      'a\u2066b',
      'a\u200Bb',
      'a\u2060b',
      'a\uFEFFb',
      'a\u{E0041}b',
    ]) {
      expect(hasOnlyTaglineChars(bad)).toBe(false)
    }
  })
})

describe('cleanTaglineInput', () => {
  it('turns breaks into spaces, removes invisible characters, and trims', () => {
    expect(cleanTaglineInput('  Global\tSystems\r\nLaboratory  ')).toBe('Global Systems Laboratory')
    expect(cleanTaglineInput('Glo\u200Bbal\u202E Lab')).toBe('Global Lab')
    expect(cleanTaglineInput('a  \u2028  b')).toBe('a b')
  })

  it('leaves what a tagline may hold alone', () => {
    expect(cleanTaglineInput('می\u200Cخواهم')).toBe('می\u200Cخواهم')
  })

  it('always returns something the rules accept', () => {
    const messy = 'x\u0000\u0007\u001F\u007F\u0080\u009F\u2066y\u{E007F}'
    expect(hasOnlyTaglineChars(cleanTaglineInput(messy))).toBe(true)
  })
})
