// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  getShaderSettings,
  initShaderSettings,
  loadSpecularPreset,
  matchSpecularPreset,
  onShaderSettingsChange,
  resetShaderSettingsForTests,
  setSpecularPreset,
  setTunerValue,
  SHADER_DEFAULTS,
  SHADER_SPECULAR_STORAGE_KEY,
  SPECULAR_PRESETS,
  TUNER_BANDS,
} from './shaderSettingsService'

beforeEach(() => {
  localStorage.clear()
  resetShaderSettingsForTests()
})

afterEach(() => {
  localStorage.clear()
  resetShaderSettingsForTests()
})

describe('SHADER_DEFAULTS', () => {
  it('uses the default specular preset for the shipped strength', () => {
    expect(SHADER_DEFAULTS.specularStrength).toBe(SPECULAR_PRESETS.default)
  })

  it('every shipped default sits inside its tuner band', () => {
    // Catches an accidental change to SHADER_DEFAULTS that puts a
    // value outside its clamp band — the renderer would clamp it
    // but the tuner slider would jump on first interaction.
    for (const [key, band] of Object.entries(TUNER_BANDS)) {
      const value = SHADER_DEFAULTS[key as keyof typeof SHADER_DEFAULTS]
      expect(value).toBeGreaterThanOrEqual(band.min)
      expect(value).toBeLessThanOrEqual(band.max)
    }
  })
})

describe('loadSpecularPreset', () => {
  it('returns null when nothing is persisted', () => {
    expect(loadSpecularPreset()).toBeNull()
  })

  it('reads back each of the three valid preset names', () => {
    for (const name of ['none', 'default', 'comfortable'] as const) {
      localStorage.setItem(SHADER_SPECULAR_STORAGE_KEY, name)
      expect(loadSpecularPreset()).toBe(name)
    }
  })

  it('rejects junk values (typo, hand-edited, stale schema)', () => {
    localStorage.setItem(SHADER_SPECULAR_STORAGE_KEY, 'NONE')
    expect(loadSpecularPreset()).toBeNull()
    localStorage.setItem(SHADER_SPECULAR_STORAGE_KEY, 'low')
    expect(loadSpecularPreset()).toBeNull()
    localStorage.setItem(SHADER_SPECULAR_STORAGE_KEY, '')
    expect(loadSpecularPreset()).toBeNull()
  })
})

describe('initShaderSettings', () => {
  it('falls back to the shipped defaults with empty storage', () => {
    const settings = initShaderSettings()
    expect(settings).toEqual(SHADER_DEFAULTS)
  })

  it('honours a persisted specular preset', () => {
    localStorage.setItem(SHADER_SPECULAR_STORAGE_KEY, 'comfortable')
    const settings = initShaderSettings()
    expect(settings.specularStrength).toBe(SPECULAR_PRESETS.comfortable)
    // Other defaults stay shipped — only specular flows through
    // localStorage; contrast / saturation / bump are dev-tuned and
    // baked into SHADER_DEFAULTS.
    expect(settings.contrast).toBe(SHADER_DEFAULTS.contrast)
    expect(settings.saturation).toBe(SHADER_DEFAULTS.saturation)
    expect(settings.bumpStrength).toBe(SHADER_DEFAULTS.bumpStrength)
  })
})

describe('setSpecularPreset', () => {
  it('writes the value to the live snapshot + localStorage', () => {
    setSpecularPreset('none')
    expect(getShaderSettings().specularStrength).toBe(0)
    expect(localStorage.getItem(SHADER_SPECULAR_STORAGE_KEY)).toBe('none')
  })

  it('fires onShaderSettingsChange listeners', () => {
    const listener = vi.fn()
    const unsubscribe = onShaderSettingsChange(listener)
    setSpecularPreset('comfortable')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0].specularStrength).toBe(SPECULAR_PRESETS.comfortable)
    unsubscribe()
    setSpecularPreset('none')
    expect(listener).toHaveBeenCalledTimes(1) // no longer subscribed
  })
})

describe('matchSpecularPreset', () => {
  it('maps each preset value back to its name', () => {
    expect(matchSpecularPreset(SPECULAR_PRESETS.none)).toBe('none')
    expect(matchSpecularPreset(SPECULAR_PRESETS.default)).toBe('default')
    expect(matchSpecularPreset(SPECULAR_PRESETS.comfortable)).toBe('comfortable')
  })

  it('tolerates floating-point drift', () => {
    expect(matchSpecularPreset(SPECULAR_PRESETS.default + 0.005)).toBe('default')
  })

  it('returns null for tuner-only values', () => {
    expect(matchSpecularPreset(0.42)).toBeNull()
    expect(matchSpecularPreset(0.9)).toBeNull()
  })
})

describe('setTunerValue', () => {
  it('writes any of the four uniforms in-band', () => {
    setTunerValue('contrast', 1.5)
    setTunerValue('saturation', 0.7)
    setTunerValue('specularStrength', 0.42)
    setTunerValue('bumpStrength', 1.25)
    const s = getShaderSettings()
    expect(s.contrast).toBe(1.5)
    expect(s.saturation).toBe(0.7)
    expect(s.specularStrength).toBeCloseTo(0.42, 5)
    expect(s.bumpStrength).toBe(1.25)
  })

  it('is a no-op for out-of-band input — keeps the previous value', () => {
    const before = getShaderSettings()
    setTunerValue('contrast', 5) // > max
    setTunerValue('specularStrength', -1) // < min
    setTunerValue('saturation', NaN)
    const after = getShaderSettings()
    expect(after).toEqual(before)
  })

  it('does NOT persist to localStorage (tuner is dev-only)', () => {
    setTunerValue('specularStrength', 0.42)
    expect(localStorage.getItem(SHADER_SPECULAR_STORAGE_KEY)).toBeNull()
  })

  it('fires onShaderSettingsChange listeners', () => {
    const listener = vi.fn()
    onShaderSettingsChange(listener)
    setTunerValue('bumpStrength', 1.5)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
