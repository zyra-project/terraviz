// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, describe, expect, it } from 'vitest'
import { pageOptOutFromBrowser, readPageOptOut } from './pageOptOut'

const plain = { embed: false, gpc: false }

describe('readPageOptOut — telemetry= in the address', () => {
  it('leaves reporting alone when the key is absent', () => {
    expect(readPageOptOut({ search: '', ...plain })).toBeNull()
    expect(readPageOptOut({ search: '?dataset=x&embed=1', ...plain })).toBeNull()
  })

  it('leaves reporting alone for 1 and true, in any case, as the output page reads them', () => {
    for (const value of ['1', 'true', 'TRUE', 'True']) {
      expect(readPageOptOut({ search: `?telemetry=${value}`, ...plain }), value).toBeNull()
    }
  })

  it('turns reporting off for every other value, an empty one included', () => {
    for (const search of [
      '?telemetry=0',
      '?telemetry=false',
      '?telemetry=off',
      '?telemetry=no',
      '?telemetry=',
      '?telemetry',
      '?telemetry=%20',
      '?telemetry=1%20',
      '?telemetry=yes',
    ]) {
      expect(readPageOptOut({ search, ...plain }), search).toBe('address')
    }
  })

  it('lets an off value win when the key repeats, so it can only lower', () => {
    expect(readPageOptOut({ search: '?telemetry=1&telemetry=0', ...plain })).toBe('address')
    expect(readPageOptOut({ search: '?telemetry=0&telemetry=1', ...plain })).toBe('address')
    expect(readPageOptOut({ search: '?telemetry=1&telemetry=true', ...plain })).toBeNull()
  })

  it('applies outside the embed view too', () => {
    expect(readPageOptOut({ search: '?telemetry=0', embed: false, gpc: false })).toBe('address')
    expect(readPageOptOut({ search: '?embed=1&telemetry=0', embed: true, gpc: false })).toBe('address')
  })
})

describe('readPageOptOut — Global Privacy Control', () => {
  it('turns reporting off in the embed view, which shows no notice', () => {
    expect(readPageOptOut({ search: '?embed=1', embed: true, gpc: true })).toBe('gpc')
  })

  it('leaves the notice and the Privacy panel in charge outside the embed view', () => {
    expect(readPageOptOut({ search: '', embed: false, gpc: true })).toBeNull()
  })

  it('needs the signal: an embed alone reports as before', () => {
    expect(readPageOptOut({ search: '?embed=1', embed: true, gpc: false })).toBeNull()
  })

  it('names the address when both apply', () => {
    expect(readPageOptOut({ search: '?embed=1&telemetry=0', embed: true, gpc: true })).toBe('address')
  })
})

describe('pageOptOutFromBrowser', () => {
  const originalUrl = window.location.href

  function setGpc(value: unknown): () => void {
    const own = Object.getOwnPropertyDescriptor(navigator, 'globalPrivacyControl')
    Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, get: () => value })
    return () => {
      if (own) Object.defineProperty(navigator, 'globalPrivacyControl', own)
      else delete (navigator as unknown as { globalPrivacyControl?: unknown }).globalPrivacyControl
    }
  }

  let restoreGpc: (() => void) | null = null

  afterEach(() => {
    restoreGpc?.()
    restoreGpc = null
    window.history.replaceState(null, '', originalUrl)
  })

  it('reads the page’s own address', () => {
    window.history.replaceState(null, '', '/?telemetry=0')
    expect(pageOptOutFromBrowser()).toBe('address')
    window.history.replaceState(null, '', '/?dataset=x')
    expect(pageOptOutFromBrowser()).toBeNull()
  })

  it('reads the embed flag the way embed mode does', () => {
    restoreGpc = setGpc(true)
    window.history.replaceState(null, '', '/?embed=1')
    expect(pageOptOutFromBrowser()).toBe('gpc')
    window.history.replaceState(null, '', '/?embed=0')
    expect(pageOptOutFromBrowser()).toBeNull()
  })

  it('takes only a true GPC signal', () => {
    window.history.replaceState(null, '', '/?embed=1')
    restoreGpc = setGpc('true')
    expect(pageOptOutFromBrowser()).toBeNull()
    restoreGpc()
    restoreGpc = setGpc(1)
    expect(pageOptOutFromBrowser()).toBeNull()
  })
})
