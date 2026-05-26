import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  initUiScale,
  loadUiScale,
  matchPreset,
  nearestPreset,
  resolveUiScale,
  sanitizeUiScale,
  setUiScale,
  UI_SCALE_PRESETS,
  UI_SCALE_STORAGE_KEY,
} from './uiScaleService'

const ORIGINAL_ENV_DEFAULT = import.meta.env.VITE_DEFAULT_UI_SCALE

function clearEnvDefault(): void {
  delete (import.meta.env as Record<string, string | undefined>).VITE_DEFAULT_UI_SCALE
}

function setEnvDefault(value: string): void {
  ;(import.meta.env as Record<string, string | undefined>).VITE_DEFAULT_UI_SCALE = value
}

beforeEach(() => {
  // Each test starts from a known clean slate — empty storage, no
  // env override. Tests that need either of these install them
  // explicitly so the precedence chain is visible at the call site.
  localStorage.clear()
  clearEnvDefault()
  document.documentElement.style.removeProperty('--ui-scale')
})

afterEach(() => {
  localStorage.clear()
  if (ORIGINAL_ENV_DEFAULT === undefined) {
    clearEnvDefault()
  } else {
    setEnvDefault(ORIGINAL_ENV_DEFAULT)
  }
  document.documentElement.style.removeProperty('--ui-scale')
})

describe('sanitizeUiScale', () => {
  it('passes through finite values inside the safe band', () => {
    expect(sanitizeUiScale(1)).toBe(1)
    expect(sanitizeUiScale(0.85)).toBe(0.85)
    expect(sanitizeUiScale(1.5)).toBe(1.5)
    expect(sanitizeUiScale(0.5)).toBe(0.5)
    expect(sanitizeUiScale(2)).toBe(2)
  })

  it('parses numeric strings (the shape localStorage returns)', () => {
    expect(sanitizeUiScale('1')).toBe(1)
    expect(sanitizeUiScale('1.5')).toBe(1.5)
    expect(sanitizeUiScale('0.85')).toBe(0.85)
  })

  it('rejects values outside the safe band', () => {
    // Below 0.5 the UI becomes untappable on mobile (~22px tap
    // targets); above 2.0 the popovers start clipping at 1366×768.
    expect(sanitizeUiScale(0.4)).toBeNull()
    expect(sanitizeUiScale(2.1)).toBeNull()
    expect(sanitizeUiScale(-1)).toBeNull()
  })

  it('rejects non-finite numbers', () => {
    expect(sanitizeUiScale(NaN)).toBeNull()
    expect(sanitizeUiScale(Infinity)).toBeNull()
    expect(sanitizeUiScale(-Infinity)).toBeNull()
  })

  it('rejects nullish and unparseable input', () => {
    expect(sanitizeUiScale(null)).toBeNull()
    expect(sanitizeUiScale(undefined)).toBeNull()
    expect(sanitizeUiScale('not a number')).toBeNull()
    expect(sanitizeUiScale({})).toBeNull()
  })
})

describe('resolveUiScale (precedence chain)', () => {
  it('prefers a persisted value over both env and default', () => {
    expect(resolveUiScale(0.85, 1.5)).toBe(0.85)
  })

  it('falls through to the env default when storage is empty', () => {
    expect(resolveUiScale(null, 1.5)).toBe(1.5)
  })

  it('falls through to 1.0 when neither storage nor env is set', () => {
    expect(resolveUiScale(null, null)).toBe(UI_SCALE_PRESETS.default)
    expect(resolveUiScale(null, null)).toBe(1)
  })

  it('respects a persisted value even when the env default is invalid', () => {
    // The env-default null is what readEnvDefault() returns when
    // sanitization fails, so this is the real-world shape.
    expect(resolveUiScale(0.85, null)).toBe(0.85)
  })
})

describe('loadUiScale (integration with localStorage + env)', () => {
  it('reads the persisted preset when present', () => {
    localStorage.setItem(UI_SCALE_STORAGE_KEY, '1.5')
    expect(loadUiScale()).toBe(1.5)
  })

  it('honours VITE_DEFAULT_UI_SCALE when storage is empty', () => {
    setEnvDefault('1.5')
    expect(loadUiScale()).toBe(1.5)
  })

  it('lets localStorage shadow the env default', () => {
    setEnvDefault('1.5')
    localStorage.setItem(UI_SCALE_STORAGE_KEY, '0.85')
    expect(loadUiScale()).toBe(0.85)
  })

  it('falls back to 1.0 when both sources are missing', () => {
    expect(loadUiScale()).toBe(1)
  })

  it('falls back to 1.0 when localStorage is corrupt (e.g. junk string)', () => {
    localStorage.setItem(UI_SCALE_STORAGE_KEY, 'nonsense')
    expect(loadUiScale()).toBe(1)
  })

  it('ignores an env default outside the safe band', () => {
    setEnvDefault('99')
    expect(loadUiScale()).toBe(1)
  })
})

describe('initUiScale', () => {
  it('writes the resolved value to :root and returns it', () => {
    localStorage.setItem(UI_SCALE_STORAGE_KEY, '1.5')
    const applied = initUiScale()
    expect(applied).toBe(1.5)
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.5')
  })

  it('applies 1.0 when storage and env are both empty', () => {
    const applied = initUiScale()
    expect(applied).toBe(1)
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1')
  })
})

describe('setUiScale', () => {
  it('persists the value, applies to :root, and returns it', () => {
    const result = setUiScale(1.5)
    expect(result).toBe(1.5)
    expect(localStorage.getItem(UI_SCALE_STORAGE_KEY)).toBe('1.5')
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.5')
  })

  it('collapses out-of-range input to the default preset', () => {
    const result = setUiScale(99)
    expect(result).toBe(UI_SCALE_PRESETS.default)
    expect(localStorage.getItem(UI_SCALE_STORAGE_KEY)).toBe('1')
  })

  it('survives a round-trip: setUiScale then loadUiScale matches', () => {
    setUiScale(UI_SCALE_PRESETS.compact)
    expect(loadUiScale()).toBe(UI_SCALE_PRESETS.compact)
  })
})

describe('matchPreset', () => {
  it('maps the exact preset values back to their names', () => {
    expect(matchPreset(1.5)).toBe('comfortable')
    expect(matchPreset(1)).toBe('default')
    expect(matchPreset(0.85)).toBe('compact')
  })

  it('tolerates tiny floating-point drift (round-trip via JSON, etc.)', () => {
    expect(matchPreset(1.5000001)).toBe('comfortable')
    expect(matchPreset(0.8499999)).toBe('compact')
  })

  it('returns null for off-preset values', () => {
    expect(matchPreset(1.25)).toBeNull()
    expect(matchPreset(2)).toBeNull()
  })
})

describe('nearestPreset', () => {
  it('returns the exact preset for preset values', () => {
    expect(nearestPreset(1.5)).toBe('comfortable')
    expect(nearestPreset(1)).toBe('default')
    expect(nearestPreset(0.85)).toBe('compact')
  })

  it('rounds freeform values to the closest preset', () => {
    // 0.9 sits between Compact (0.85) and Default (1.0) — closer
    // to Compact by 0.05 vs 0.10, so the highlight lands there.
    expect(nearestPreset(0.9)).toBe('compact')
    // 1.25 sits between Default (1.0) and Comfortable (1.5) —
    // closer to Comfortable by 0.25 vs 0.25... actually equidistant.
    // Falls to whichever is iterated first; we just assert it's
    // *one of them* so the test isn't brittle to iteration order.
    expect(['default', 'comfortable']).toContain(nearestPreset(1.25))
    expect(nearestPreset(1.4)).toBe('comfortable')
  })

  it('never returns null — out-of-band values still map to a preset', () => {
    // A forker hand-editing localStorage to something silly still
    // gets a meaningful radio highlight rather than an
    // unselected radiogroup. (sanitizeUiScale rejects these at the
    // load layer, but matchPreset / nearestPreset are pure-value.)
    expect(nearestPreset(5)).toBe('comfortable')
    expect(nearestPreset(0)).toBe('compact')
  })
})
