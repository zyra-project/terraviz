import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadConfig,
  saveConfig,
  setTier,
  generateSessionId,
} from './config'

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
