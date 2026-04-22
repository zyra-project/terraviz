import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  loadViewPreferences,
  saveViewPreferences,
  getBordersVisible,
  setBordersVisible,
  setGazeFollowOverlays,
} from './viewPreferences'

describe('viewPreferences', () => {
  beforeEach(() => {
    localStorage.clear()
    // Reset the module-level cache to defaults so tests don't
    // inherit field-level state from each other. The setters are
    // the only way to touch the cache from outside; calling both
    // with the defaults ensures a clean slate. Clearing localStorage
    // again afterwards wipes the setter's own writes so each test
    // starts from empty storage.
    setBordersVisible(false)
    setGazeFollowOverlays(false)
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('returns defaults when localStorage is empty', () => {
    const prefs = loadViewPreferences()
    expect(prefs.infoPanelVisible).toBe(true)
    expect(prefs.legendVisible).toBe(true)
    expect(prefs.bordersVisible).toBe(false)
    expect(prefs.gazeFollowOverlays).toBe(false)
  })

  it('round-trips blob-path fields (info panel + legend)', () => {
    saveViewPreferences({
      infoPanelVisible: false, legendVisible: true,
      bordersVisible: false, gazeFollowOverlays: false,
    })
    const prefs = loadViewPreferences()
    expect(prefs.infoPanelVisible).toBe(false)
    expect(prefs.legendVisible).toBe(true)
  })

  it('blob save does not clobber borders / gazeFollow from their setters', () => {
    // Establish cache state via the field-level setters — mirrors a
    // tour or Tools-menu toggle happening between a caller's
    // `loadViewPreferences()` snapshot and a later save.
    setBordersVisible(true)
    setGazeFollowOverlays(true)
    // Caller's blob still has the stale (pre-setter) values.
    saveViewPreferences({
      infoPanelVisible: false, legendVisible: false,
      bordersVisible: false, gazeFollowOverlays: false,
    })
    const prefs = loadViewPreferences()
    // Blob-path fields take the caller's values.
    expect(prefs.infoPanelVisible).toBe(false)
    expect(prefs.legendVisible).toBe(false)
    // Field-level flags preserved, not the caller's stale values.
    expect(prefs.bordersVisible).toBe(true)
    expect(prefs.gazeFollowOverlays).toBe(true)
  })

  it('falls back to defaults on malformed JSON', () => {
    localStorage.setItem('sos-view-prefs', '{not valid json')
    const prefs = loadViewPreferences()
    expect(prefs.infoPanelVisible).toBe(true)
    expect(prefs.legendVisible).toBe(true)
    expect(prefs.bordersVisible).toBe(false)
    expect(prefs.gazeFollowOverlays).toBe(false)
  })

  it('falls back to defaults for fields with wrong type', () => {
    localStorage.setItem('sos-view-prefs', JSON.stringify({
      infoPanelVisible: 'yes',
      legendVisible: 0,
      bordersVisible: 'on',
      gazeFollowOverlays: 1,
    }))
    const prefs = loadViewPreferences()
    expect(prefs.infoPanelVisible).toBe(true)
    expect(prefs.legendVisible).toBe(true)
    expect(prefs.bordersVisible).toBe(false)
    expect(prefs.gazeFollowOverlays).toBe(false)
  })

  it('preserves a known good field when another is invalid', () => {
    localStorage.setItem('sos-view-prefs', JSON.stringify({
      infoPanelVisible: false,
      legendVisible: 'bogus',
    }))
    const prefs = loadViewPreferences()
    expect(prefs.infoPanelVisible).toBe(false)
    expect(prefs.legendVisible).toBe(true)
  })

  it('swallows save errors without throwing', () => {
    // Simulate a storage quota error by stubbing setItem
    const orig = Storage.prototype.setItem
    Storage.prototype.setItem = vi.fn(() => { throw new Error('quota') })
    try {
      expect(() => saveViewPreferences({
        infoPanelVisible: false, legendVisible: false,
        bordersVisible: false, gazeFollowOverlays: false,
      })).not.toThrow()
    } finally {
      Storage.prototype.setItem = orig
    }
  })

  describe('shared borders flag', () => {
    it('setter round-trips through loadViewPreferences', () => {
      setBordersVisible(true)
      expect(getBordersVisible()).toBe(true)
      expect(loadViewPreferences().bordersVisible).toBe(true)
    })

    it('toggle survives a cache-is-stale scenario', () => {
      // Regression coverage: user toggles borders in VR, VR writes
      // to localStorage + cache. A later read through
      // `loadViewPreferences` must see the update, not an older
      // cached blob.
      setBordersVisible(false)
      setBordersVisible(true)
      expect(loadViewPreferences().bordersVisible).toBe(true)
      setBordersVisible(false)
      expect(loadViewPreferences().bordersVisible).toBe(false)
    })
  })
})
