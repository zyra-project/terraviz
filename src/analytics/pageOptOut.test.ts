// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

  it('reads the part after # too, so #telemetry=0 cannot leave an embed reporting', () => {
    expect(readPageOptOut({ search: '?embed=1', hash: '#telemetry=0', ...plain })).toBe('address')
    expect(readPageOptOut({ search: '?embed=1', hash: 'telemetry=0', ...plain })).toBe('address')
    expect(readPageOptOut({ search: '?telemetry=1', hash: '#telemetry=0', ...plain })).toBe('address')
    expect(readPageOptOut({ search: '?telemetry=0', hash: '#telemetry=1', ...plain })).toBe('address')
    expect(readPageOptOut({ search: '', hash: '#telemetry=1', ...plain })).toBeNull()
  })

  it('ignores a fragment that is an ordinary anchor', () => {
    expect(readPageOptOut({ search: '', hash: '#section-2', ...plain })).toBeNull()
    expect(readPageOptOut({ search: '', hash: '#', ...plain })).toBeNull()
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

  it('reads the page’s own address, query and fragment', () => {
    window.history.replaceState(null, '', '/?telemetry=0')
    expect(pageOptOutFromBrowser()).toBe('address')
    window.history.replaceState(null, '', '/?embed=1#telemetry=0')
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

// main.ts exports nothing and boots on import, so its wiring cannot be
// driven from a test. These pin the two things a refactor could move
// silently: the latch must come before any transport is installed, and
// the first-run notice must stay behind it.
describe('main.ts wiring', () => {
  const main = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf-8')

  it('latches the opt-out at module evaluation, before the transport is installed', () => {
    const latch = main.indexOf('if (pageOptOut) optOutForPage(pageOptOut)')
    const domReady = main.indexOf("document.addEventListener('DOMContentLoaded'")
    const transport = main.indexOf('setTransport(createFetchTransport())')
    expect(latch).toBeGreaterThan(-1)
    expect(transport).toBeGreaterThan(-1)
    expect(latch).toBeLessThan(transport)
    // A top-level statement: before the class and boot handler that
    // install anything, not inside them.
    expect(latch).toBeLessThan(main.indexOf('class InteractiveSphere'))
    expect(latch).toBeLessThan(domReady)
  })

  it('keeps the first-run notice off a page whose address opted out', () => {
    expect(main).toContain('if (!embedModeActive && !getPageOptOut()) showDisclosureBannerIfNeeded()')
  })
})
