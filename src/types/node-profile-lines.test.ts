// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The character rules for the node's display lines (the loading-screen
 * tagline and the dataset browser's subtitle). What is refused is
 * what makes the stored text differ from what a reviewer sees, or
 * lets it break out of one line; what is kept is what real scripts
 * need.
 */

import { describe, expect, it } from 'vitest'
import { cleanDisplayLineInput, hasOnlyDisplayLineChars } from './node-profile-lines'

describe('hasOnlyDisplayLineChars', () => {
  it('accepts ordinary text in any script', () => {
    for (const ok of [
      'Global Systems Laboratory',
      'Laboratorio de Sistemas Globales',
      'مختبر الأنظمة العالمية',
      'मौसम\u200Dविज्ञान', // ZWJ, which Indic scripts need
      'می\u200Cخواهم', // ZWNJ, which Persian needs
      'abc \u200F def', // RLM, which right-to-left text uses
      '\u061C\u0661', // ALM
      'Lab \u{1F469}\u200D\u{1F52C}', // an emoji ZWJ sequence: astral, not lone surrogates
      'Cafe\u0301', // a combining accent
    ]) {
      expect(hasOnlyDisplayLineChars(ok)).toBe(true)
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
      // Format characters beyond the named ones, by category.
      'a\u00ADb', // soft hyphen
      'a\u180Eb',
      'a\u206Ab',
      'a\uFFF9b', // interlinear annotation anchor
      'a\u0600b',
      // Letters that draw as blanks.
      '\u3164',
      '\u115F',
      '\uFFA0',
      '\u2800',
      'a\u034Fb',
      // A lone surrogate, which a JSON body can carry.
      'a\uD800b',
    ]) {
      expect(hasOnlyDisplayLineChars(bad)).toBe(false)
    }
  })
})

describe('cleanDisplayLineInput', () => {
  it('turns breaks into spaces, removes invisible characters, and trims', () => {
    expect(cleanDisplayLineInput('  Global\tSystems\r\nLaboratory  ')).toBe('Global Systems Laboratory')
    expect(cleanDisplayLineInput('Glo\u200Bbal\u202E Lab')).toBe('Global Lab')
    expect(cleanDisplayLineInput('a  \u2028  b')).toBe('a b')
  })

  it('empties a tagline that was only blank-looking letters', () => {
    expect(cleanDisplayLineInput('\u3164 \u2800')).toBe('')
  })

  it('leaves what a tagline may hold alone', () => {
    expect(cleanDisplayLineInput('می\u200Cخواهم')).toBe('می\u200Cخواهم')
  })

  it('always returns something the rules accept', () => {
    const messy = 'x\u0000\u0007\u001F\u007F\u0080\u009F\u2066y\u{E007F}'
    expect(hasOnlyDisplayLineChars(cleanDisplayLineInput(messy))).toBe(true)
  })
})
