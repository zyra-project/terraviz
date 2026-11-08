// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadConfig,
  saveConfig,
  setTier,
  generateSessionId,
  resolveConsoleMode,
  TELEMETRY_CONSOLE_MODE,
} from './config'

describe('resolveConsoleMode', () => {
  it('is on under the dev server when nothing is set', () => {
    expect(resolveConsoleMode(undefined, 'development')).toBe(true)
  })

  it('is off in a built bundle and under vitest when nothing is set', () => {
    expect(resolveConsoleMode(undefined, 'production')).toBe(false)
    expect(resolveConsoleMode(undefined, 'test')).toBe(false)
    expect(resolveConsoleMode(undefined, undefined)).toBe(false)
  })

  it("honours an explicit 'false', so the dev server can test the real transport", () => {
    expect(resolveConsoleMode('false', 'development')).toBe(false)
  })

  it("honours an explicit 'true' in any mode", () => {
    expect(resolveConsoleMode('true', 'production')).toBe(true)
    expect(resolveConsoleMode('true', 'test')).toBe(true)
  })

  it('falls back to the mode for any other value, as before for builds', () => {
    // Only the exact strings decide; a typo neither turns sending on
    // in dev nor turns it off in a build.
    for (const raw of ['', 'TRUE', '1', '0', 'off', 'yes']) {
      expect(resolveConsoleMode(raw, 'development')).toBe(true)
      expect(resolveConsoleMode(raw, 'production')).toBe(false)
    }
  })

  it('leaves the constant off under vitest unless the env says true', () => {
    // The exported constant, not the function: vitest runs in mode
    // `test`, so the constant is off unless VITE_TELEMETRY_CONSOLE is
    // exactly 'true', and the emitter tests keep the transport path.
    // A constant built from `import.meta.env.DEV` (true under vitest)
    // or from the wrong variable fails here.
    expect(import.meta.env.MODE).toBe('test')
    expect(TELEMETRY_CONSOLE_MODE).toBe(import.meta.env.VITE_TELEMETRY_CONSOLE === 'true')
  })
})

describe('config — load / save / setTier', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns the default tier when nothing is persisted', () => {
    expect(loadConfig()).toEqual({ tier: 'essential' })
  })

  it('round-trips a saved tier through localStorage', () => {
    saveConfig({ tier: 'research' })
    expect(loadConfig()).toEqual({ tier: 'research' })
  })

  it('setTier is a shortcut for saveConfig({ tier })', () => {
    setTier('off')
    expect(loadConfig()).toEqual({ tier: 'off' })
  })

  it('falls back to defaults on invalid JSON', () => {
    localStorage.setItem('sos-telemetry-config', '{not-json')
    expect(loadConfig()).toEqual({ tier: 'essential' })
  })

  it('falls back to defaults on an unrecognized tier value', () => {
    localStorage.setItem('sos-telemetry-config', JSON.stringify({ tier: 'maximum' }))
    expect(loadConfig()).toEqual({ tier: 'essential' })
  })

  it('falls back to defaults when the persisted value is not an object', () => {
    localStorage.setItem('sos-telemetry-config', JSON.stringify('essential'))
    expect(loadConfig()).toEqual({ tier: 'essential' })
  })
})

describe('generateSessionId', () => {
  it('returns a non-empty string', () => {
    const id = generateSessionId()
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  it('produces distinct values on successive calls', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 20; i++) ids.add(generateSessionId())
    expect(ids.size).toBe(20)
  })

  it('produces a UUID-shaped string when crypto.randomUUID is available', () => {
    const id = generateSessionId()
    // 8-4-4-4-12 hex pattern. Not a strict validator — just a sanity check.
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  })
})
