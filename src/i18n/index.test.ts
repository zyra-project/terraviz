// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, beforeEach } from 'vitest'
import {
  __installMessagesForTests,
  __resetI18nForTests,
  getLocale,
  initI18n,
  interpolate,
  plural,
  setLocale,
  t,
  SOURCE_LOCALE,
} from './index'

describe('i18n runtime', () => {
  beforeEach(() => {
    __resetI18nForTests()
  })

  describe('interpolate', () => {
    it('substitutes named placeholders', () => {
      expect(interpolate('Hello, {name}!', { name: 'world' })).toBe('Hello, world!')
    })

    it('coerces numbers to strings', () => {
      expect(interpolate('{count} datasets', { count: 3 })).toBe('3 datasets')
    })

    it('leaves unresolved placeholders in place', () => {
      // Surfaces missing translation parameters during dev rather than
      // silently dropping them.
      expect(interpolate('Hello, {name}!', {})).toBe('Hello, {name}!')
    })

    it('substitutes the same placeholder multiple times', () => {
      expect(interpolate('{x}+{x}={y}', { x: 1, y: 2 })).toBe('1+1=2')
    })
  })

  describe('t', () => {
    it('returns the raw key when neither active nor English has it', () => {
      // Both lookup tables miss → t() returns the key itself so a
      // missing translation surfaces visibly rather than rendering blank.
      expect(t('totally.bogus.key' as never)).toBe('totally.bogus.key')
    })

    it('returns the active locale value when set', () => {
      __installMessagesForTests('en', { 'app.title': 'Override' })
      expect(t('app.title' as never)).toBe('Override')
    })

    it('falls back to English when the active locale is missing the key', () => {
      // Empty Spanish bundle → resolution falls through to the
      // baked-in `enMessages` (whose `app.title` is "Terraviz" once
      // Wave 1 populated en.json).
      __installMessagesForTests('es', {})
      expect(t('app.title' as never)).toBe('Terraviz')
    })

    it('interpolates params when supplied', () => {
      __installMessagesForTests('en', { 'browse.count': '{count} datasets' })
      expect(t('browse.count' as never, { count: 7 })).toBe('7 datasets')
    })
  })

  describe('plural', () => {
    it('selects the "one" form for count=1 in English', () => {
      __installMessagesForTests('en', {
        'browse.count.one': '1 dataset',
        'browse.count.other': '{count} datasets',
      })
      expect(
        plural(
          1,
          { one: 'browse.count.one' as never, other: 'browse.count.other' as never },
        ),
      ).toBe('1 dataset')
    })

    it('selects "other" for count=5 and auto-injects {count}', () => {
      __installMessagesForTests('en', {
        'browse.count.one': '1 dataset',
        'browse.count.other': '{count} datasets',
      })
      expect(
        plural(
          5,
          { one: 'browse.count.one' as never, other: 'browse.count.other' as never },
        ),
      ).toBe('5 datasets')
    })

    it('falls back to "other" if the chosen form is not provided', () => {
      __installMessagesForTests('en', { 'count.other': '{count} items' })
      expect(plural(1, { other: 'count.other' as never })).toBe('1 items')
    })
  })

  describe('initI18n', () => {
    it('takes no parameter — it always installs the source bundle', () => {
      // Pin the no-arg contract: initI18n previously accepted a
      // `locale` argument but always set the English bundle, which
      // produced a half-translated UI when callers passed
      // anything else. The function is now arg-less.
      expect(initI18n.length).toBe(0)
    })

    it('writes the active locale + DOM attributes on call', () => {
      // Previous setLocale call may have left state — reset.
      __resetI18nForTests()
      initI18n()
      expect(getLocale()).toBe(SOURCE_LOCALE)
      expect(document.documentElement.lang).toBe(SOURCE_LOCALE)
    })
  })

  describe('setLocale', () => {
    it('returns the source locale by default', () => {
      expect(getLocale()).toBe(SOURCE_LOCALE)
    })

    it('is callable on the source locale without throwing (no-op transition)', async () => {
      // setLocale to the already-active locale is a no-op fast
      // path. The DOM-attribute side effects of switching ARE
      // exercised by the initI18n test above; here we just pin
      // the public API contract.
      await setLocale(SOURCE_LOCALE)
      expect(getLocale()).toBe(SOURCE_LOCALE)
    })
  })
})
