import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { loadViewPreferences, saveViewPreferences } from './viewPreferences'

describe('viewPreferences', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('returns defaults when localStorage is empty', () => {
    const prefs = loadViewPreferences()
    expect(prefs.infoPanelVisible).toBe(true)
    expect(prefs.legendVisible).toBe(true)
  })

  it('round-trips a saved preference', () => {
    saveViewPreferences({ infoPanelVisible: false, legendVisible: true })
    const prefs = loadViewPreferences()
    expect(prefs.infoPanelVisible).toBe(false)
    expect(prefs.legendVisible).toBe(true)
  })

  it('round-trips both flags independently', () => {
    saveViewPreferences({ infoPanelVisible: false, legendVisible: false })
    const prefs = loadViewPreferences()
    expect(prefs.infoPanelVisible).toBe(false)
    expect(prefs.legendVisible).toBe(false)
  })

  it('falls back to defaults on malformed JSON', () => {
    localStorage.setItem('sos-view-prefs', '{not valid json')
    const prefs = loadViewPreferences()
    expect(prefs.infoPanelVisible).toBe(true)
    expect(prefs.legendVisible).toBe(true)
  })

  it('falls back to defaults for fields with wrong type', () => {
    localStorage.setItem('sos-view-prefs', JSON.stringify({
      infoPanelVisible: 'yes',
      legendVisible: 0,
    }))
    const prefs = loadViewPreferences()
    expect(prefs.infoPanelVisible).toBe(true)
    expect(prefs.legendVisible).toBe(true)
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
      expect(() => saveViewPreferences({ infoPanelVisible: false, legendVisible: false }))
        .not.toThrow()
    } finally {
      Storage.prototype.setItem = orig
    }
  })
})
