// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { t } from './index'
import { __resetI18nTraceForTests, recordI18nKey } from './screenshotTrace'

describe('screenshot trace', () => {
  beforeEach(() => {
    __resetI18nTraceForTests()
    delete (window as { __i18nTrace?: unknown }).__i18nTrace
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('recordI18nKey', () => {
    it('collects keys and publishes the handle on window', () => {
      expect(window.__i18nTrace).toBeUndefined()

      recordI18nKey('browse.card.load')
      recordI18nKey('tools.toggle.labels')

      expect(window.__i18nTrace).toBeDefined()
      expect([...window.__i18nTrace!.seen]).toEqual([
        'browse.card.load',
        'tools.toggle.labels',
      ])
    })

    it('dedupes repeated keys', () => {
      recordI18nKey('app.title')
      recordI18nKey('app.title')
      expect([...window.__i18nTrace!.seen]).toEqual(['app.title'])
    })

    it('reset() clears the set but keeps the handle', () => {
      recordI18nKey('app.title')
      window.__i18nTrace!.reset()
      expect([...window.__i18nTrace!.seen]).toEqual([])
      expect(window.__i18nTrace).toBeDefined()
    })
  })

  describe('t() gating', () => {
    it('does not trace when VITE_I18N_TRACE is unset (normal build)', () => {
      // Default vitest env has the flag off, mirroring a normal build.
      t('app.title' as never)
      expect(window.__i18nTrace).toBeUndefined()
    })

    it('traces resolved keys when VITE_I18N_TRACE is on', () => {
      vi.stubEnv('VITE_I18N_TRACE', 'true')
      t('app.title' as never)
      t('browse.card.load' as never)
      expect(window.__i18nTrace).toBeDefined()
      expect([...window.__i18nTrace!.seen]).toEqual([
        'app.title',
        'browse.card.load',
      ])
    })
  })
})
