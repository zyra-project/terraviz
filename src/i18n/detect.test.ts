// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, beforeEach } from 'vitest'
import { detectLocale, pickFallback } from './detect'
import { clearLocalePref, saveLocalePref } from './persistence'

describe('pickFallback (BCP-47 ladder)', () => {
  const supported = ['en', 'es', 'pt-BR']

  it('matches an exact tag', () => {
    expect(pickFallback('en', supported)).toBe('en')
    expect(pickFallback('pt-BR', supported)).toBe('pt-BR')
  })

  it('walks down to the base tag', () => {
    expect(pickFallback('es-MX', supported)).toBe('es')
  })

  it('walks down through region/script subtags', () => {
    expect(pickFallback('zh-Hant-TW', ['zh'])).toBe('zh')
    expect(pickFallback('zh-Hant-TW', ['zh-Hant'])).toBe('zh-Hant')
  })

  it('returns undefined when no tag in the ladder is supported', () => {
    expect(pickFallback('fr-CA', supported)).toBeUndefined()
  })

  it('lowercases as a defensive secondary attempt', () => {
    expect(pickFallback('EN', ['en'])).toBe('en')
  })

  it('returns undefined for an empty input', () => {
    expect(pickFallback('', supported)).toBeUndefined()
  })

  it('does not match when supported list is empty', () => {
    expect(pickFallback('en', [])).toBeUndefined()
  })
})

describe('detectLocale (resolution chain)', () => {
  const supported = ['en', 'es', 'pt-BR']
  const fallback = 'en'

  beforeEach(() => {
    clearLocalePref()
  })

  it('uses stored preference when present and valid', () => {
    saveLocalePref('es')
    expect(detectLocale({ supported, fallback, navigatorLanguages: ['fr-FR'] })).toBe('es')
  })

  it('ignores stored preference if locale is no longer supported', () => {
    saveLocalePref('zz')
    expect(
      detectLocale({ supported, fallback, navigatorLanguages: ['en'], queryLang: null }),
    ).toBe('en')
  })

  it('uses ?lang= when no stored preference', () => {
    expect(
      detectLocale({ supported, fallback, queryLang: 'pt-BR', navigatorLanguages: [] }),
    ).toBe('pt-BR')
  })

  it('falls through to navigator.languages when query is empty', () => {
    expect(
      detectLocale({
        supported,
        fallback,
        queryLang: null,
        navigatorLanguages: ['de-DE', 'es-MX', 'en'],
      }),
    ).toBe('es')
  })

  it('uses fallback when nothing matches', () => {
    expect(
      detectLocale({
        supported,
        fallback,
        queryLang: null,
        navigatorLanguages: ['de', 'fr-CA'],
      }),
    ).toBe('en')
  })

  it('skips unsupported query lang and continues to navigator', () => {
    expect(
      detectLocale({
        supported,
        fallback,
        queryLang: 'zz',
        navigatorLanguages: ['es-AR'],
      }),
    ).toBe('es')
  })

  it('navigator.languages only matches picker-eligible locales when pickerSupported is narrower', () => {
    // Browser is set to Arabic; Arabic is loadable (in `supported`)
    // but below the picker-visibility threshold (NOT in
    // `pickerSupported`). Auto-detect should fall through to the
    // default rather than land the visitor on an empty Arabic UI.
    expect(
      detectLocale({
        supported: ['en', 'es', 'ar'],
        pickerSupported: ['en', 'es'],
        fallback,
        queryLang: null,
        navigatorLanguages: ['ar-EG'],
      }),
    ).toBe('en')
  })

  it('?lang= still accepts below-threshold locales when pickerSupported is narrower', () => {
    // The explicit `?lang=ar` override is how a tester or translator
    // previews a below-threshold locale. The narrower
    // `pickerSupported` must not block this path.
    expect(
      detectLocale({
        supported: ['en', 'es', 'ar'],
        pickerSupported: ['en', 'es'],
        fallback,
        queryLang: 'ar',
        navigatorLanguages: [],
      }),
    ).toBe('ar')
  })

  it('stored pref still accepts below-threshold locales when pickerSupported is narrower', () => {
    // If a user previously picked `ar` (or landed there via `?lang=ar`
    // and the harness persisted the choice), `pickerSupported`
    // narrowing shouldn't silently bounce them to English on next
    // visit.
    saveLocalePref('ar')
    expect(
      detectLocale({
        supported: ['en', 'es', 'ar'],
        pickerSupported: ['en', 'es'],
        fallback,
        queryLang: null,
        navigatorLanguages: ['en'],
      }),
    ).toBe('ar')
  })

  it('falls back to `supported` for navigator when pickerSupported is omitted (legacy callers)', () => {
    // Older callers that don't pass `pickerSupported` get the
    // unchanged "navigator matches anything in supported" behavior.
    expect(
      detectLocale({
        supported: ['en', 'es', 'ar'],
        fallback,
        queryLang: null,
        navigatorLanguages: ['ar-EG'],
      }),
    ).toBe('ar')
  })
})
