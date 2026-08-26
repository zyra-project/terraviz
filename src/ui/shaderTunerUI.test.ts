// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { maybeInitShaderTuner } from './shaderTunerUI'
import {
  getShaderSettings,
  resetShaderSettingsForTests,
  SHADER_DEFAULTS,
} from '../services/shaderSettingsService'

function setUrl(search: string): void {
  const url = new URL(`http://localhost/?${search}`)
  Object.defineProperty(window, 'location', {
    value: url,
    writable: true,
    configurable: true,
  })
}

beforeEach(() => {
  document.body.innerHTML = ''
  // Force the readyState to a value that makes maybeInitShaderTuner
  // mount synchronously rather than wait for DOMContentLoaded.
  Object.defineProperty(document, 'readyState', {
    value: 'complete',
    writable: true,
    configurable: true,
  })
  resetShaderSettingsForTests()
})

afterEach(() => {
  document.body.innerHTML = ''
  resetShaderSettingsForTests()
})

describe('maybeInitShaderTuner', () => {
  it('does nothing without ?tune=shader', () => {
    setUrl('')
    maybeInitShaderTuner()
    expect(document.getElementById('shader-tuner')).toBeNull()
  })

  it('does nothing with ?tune=other', () => {
    setUrl('tune=other')
    maybeInitShaderTuner()
    expect(document.getElementById('shader-tuner')).toBeNull()
  })

  it('mounts a panel with four sliders when ?tune=shader is set', () => {
    setUrl('tune=shader')
    maybeInitShaderTuner()
    const host = document.getElementById('shader-tuner')
    expect(host).not.toBeNull()
    const sliders = host!.querySelectorAll('input[type="range"]')
    expect(sliders.length).toBe(4)
    // Each slider's data-key matches one of the four uniforms.
    const keys = Array.from(sliders).map((s) => (s as HTMLInputElement).dataset.key)
    expect(new Set(keys)).toEqual(new Set(['contrast', 'saturation', 'specularStrength', 'bumpStrength']))
  })

  it('initial slider values match the live shader settings snapshot', () => {
    setUrl('tune=shader')
    maybeInitShaderTuner()
    const host = document.getElementById('shader-tuner')!
    const s = getShaderSettings()
    for (const key of ['contrast', 'saturation', 'specularStrength', 'bumpStrength'] as const) {
      const input = host.querySelector<HTMLInputElement>(`input[data-key="${key}"]`)!
      expect(Number(input.value)).toBeCloseTo(s[key], 5)
    }
  })

  it('slider input writes through to shaderSettingsService', () => {
    setUrl('tune=shader')
    maybeInitShaderTuner()
    const host = document.getElementById('shader-tuner')!
    const input = host.querySelector<HTMLInputElement>('input[data-key="contrast"]')!
    input.value = '0.85'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(getShaderSettings().contrast).toBeCloseTo(0.85, 5)
  })

  it('close button removes the panel from the DOM', () => {
    setUrl('tune=shader')
    maybeInitShaderTuner()
    const host = document.getElementById('shader-tuner')!
    const close = host.querySelector<HTMLButtonElement>('#shader-tuner-close')!
    close.click()
    expect(document.getElementById('shader-tuner')).toBeNull()
  })

  it('reset button restores SHADER_DEFAULTS', () => {
    setUrl('tune=shader')
    maybeInitShaderTuner()
    const host = document.getElementById('shader-tuner')!
    // Tweak two values.
    const c = host.querySelector<HTMLInputElement>('input[data-key="contrast"]')!
    c.value = '0.5'
    c.dispatchEvent(new Event('input', { bubbles: true }))
    const s = host.querySelector<HTMLInputElement>('input[data-key="saturation"]')!
    s.value = '0.5'
    s.dispatchEvent(new Event('input', { bubbles: true }))
    // Reset.
    const reset = host.querySelector<HTMLButtonElement>('#shader-tuner-reset')!
    reset.click()
    expect(getShaderSettings().contrast).toBeCloseTo(SHADER_DEFAULTS.contrast, 5)
    expect(getShaderSettings().saturation).toBeCloseTo(SHADER_DEFAULTS.saturation, 5)
  })

  it('is idempotent — calling twice does not stack panels', () => {
    setUrl('tune=shader')
    maybeInitShaderTuner()
    maybeInitShaderTuner()
    const hosts = document.querySelectorAll('#shader-tuner')
    expect(hosts.length).toBe(1)
  })
})
