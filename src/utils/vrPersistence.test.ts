// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  savePersistedAnchorHandle,
  loadPersistedAnchorHandle,
  clearPersistedAnchorHandle,
} from './vrPersistence'

/**
 * vrPersistence owns a very small responsibility — round-trip a
 * WebXR anchor's persistent-handle UUID through localStorage — but
 * the error-tolerance paths matter. Private browsing can throw on
 * localStorage access, quota can be exceeded, and saved data can
 * be stale or corrupt. Tests cover the happy path plus each failure
 * mode so a regression in graceful-degradation shows up here rather
 * than on-headset.
 */

const STORAGE_KEY = 'sos-vr-globe-anchor-handle'

describe('vrPersistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  describe('round-trip', () => {
    it('returns null when no handle has been saved', () => {
      expect(loadPersistedAnchorHandle()).toBeNull()
    })

    it('saves and loads a handle UUID verbatim', () => {
      const handle = '550e8400-e29b-41d4-a716-446655440000'
      savePersistedAnchorHandle(handle)
      expect(loadPersistedAnchorHandle()).toBe(handle)
    })

    it('overwrites an existing handle on re-save', () => {
      savePersistedAnchorHandle('first')
      savePersistedAnchorHandle('second')
      expect(loadPersistedAnchorHandle()).toBe('second')
    })

    it('clearPersistedAnchorHandle removes the saved value', () => {
      savePersistedAnchorHandle('handle-to-clear')
      expect(loadPersistedAnchorHandle()).toBe('handle-to-clear')
      clearPersistedAnchorHandle()
      expect(loadPersistedAnchorHandle()).toBeNull()
    })

    it('uses the documented storage key so other code can inspect it', () => {
      savePersistedAnchorHandle('handle')
      expect(localStorage.getItem(STORAGE_KEY)).toBe('handle')
    })

    it('handles empty-string handles without confusing them for "no handle"', () => {
      // An empty string IS truthy from localStorage's perspective —
      // it's distinct from null ("not present"). Make sure we
      // round-trip it faithfully (even though it's unusual).
      savePersistedAnchorHandle('')
      expect(loadPersistedAnchorHandle()).toBe('')
    })
  })

  describe('error tolerance', () => {
    it('save: swallows errors when localStorage.setItem throws', () => {
      // Simulate private-browsing quota errors or
      // SecurityError-in-iframe-with-cookies-disabled scenarios.
      // Spying on the instance (not the prototype) because happy-dom
      // implements Storage methods directly on the instance.
      const setItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
        throw new DOMException('quota exceeded', 'QuotaExceededError')
      })
      expect(() => savePersistedAnchorHandle('handle')).not.toThrow()
      expect(setItemSpy).toHaveBeenCalled()
    })

    it('load: returns null when localStorage.getItem throws', () => {
      vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
        throw new DOMException('access denied', 'SecurityError')
      })
      expect(loadPersistedAnchorHandle()).toBeNull()
    })

    it('clear: swallows errors when localStorage.removeItem throws', () => {
      vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
        throw new DOMException('access denied', 'SecurityError')
      })
      expect(() => clearPersistedAnchorHandle()).not.toThrow()
    })
  })
})
