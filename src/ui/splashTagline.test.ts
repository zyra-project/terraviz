// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The loading screen's tagline: a node's own line replaces the
 * default, no line keeps it, and either way the held-back subtitle is
 * revealed — a subtitle left `pending` would only come back through
 * the CSS deadline, a beat late on every load.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SPLASH_TAGLINE_PENDING_ATTR,
  bindSplashTagline,
  isNodeTagline,
  resetSplashTaglineForTests,
  splashTagline,
} from './splashTagline'

function subtitle(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'loading-subtitle'
  el.setAttribute('data-i18n', 'loading.subtitle')
  el.setAttribute('data-tagline', 'pending')
  el.textContent = 'Science On a Sphere'
  return el
}

afterEach(() => {
  vi.useRealTimers()
  resetSplashTaglineForTests()
})

describe('bindSplashTagline', () => {
  it("writes the node's tagline in, drops the i18n key, and reveals it", async () => {
    const el = subtitle()
    await bindSplashTagline(el, Promise.resolve('Global Systems Laboratory'))
    expect(el.textContent).toBe('Global Systems Laboratory')
    expect(el.hasAttribute('data-i18n')).toBe(false)
    expect(el.hasAttribute('data-tagline')).toBe(false)
    expect(splashTagline()).toBe('Global Systems Laboratory')
    expect(isNodeTagline()).toBe(true)
  })

  it("marks the node's line as of unknown language and direction", async () => {
    // So a Turkish page does not case an English name with dotted
    // capitals, and a left-to-right name lays out on an RTL page.
    const el = subtitle()
    await bindSplashTagline(el, Promise.resolve('Global Systems Laboratory'))
    expect(el.getAttribute('lang')).toBe('')
    expect(el.getAttribute('dir')).toBe('auto')
  })

  it('reveals the default at the deadline, and still applies a tagline that lands after it', async () => {
    vi.useFakeTimers()
    const el = subtitle()
    let answer!: (value: string | null) => void
    const done = bindSplashTagline(el, new Promise(resolve => (answer = resolve)), { revealAfterMs: 1500 })
    await vi.advanceTimersByTimeAsync(1499)
    expect(el.hasAttribute('data-tagline')).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(el.hasAttribute('data-tagline')).toBe(false)
    expect(el.textContent).toBe('Science On a Sphere')
    answer('Global Systems Laboratory')
    await done
    expect(el.textContent).toBe('Global Systems Laboratory')
  })

  it('reveals at once when the tagline beats the deadline', async () => {
    vi.useFakeTimers()
    const el = subtitle()
    await bindSplashTagline(el, Promise.resolve('Global Systems Laboratory'), { revealAfterMs: 1500 })
    expect(el.hasAttribute('data-tagline')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the default and reveals it when the node has none', async () => {
    for (const value of [null, '', '   ']) {
      const el = subtitle()
      await bindSplashTagline(el, Promise.resolve(value))
      expect(el.textContent).toBe('Science On a Sphere')
      expect(el.getAttribute('data-i18n')).toBe('loading.subtitle')
      expect(el.hasAttribute('data-tagline')).toBe(false)
      expect(splashTagline()).toBe('Science On a Sphere')
    }
  })

  it('reveals the default when the read rejects', async () => {
    const el = subtitle()
    await bindSplashTagline(el, Promise.reject(new Error('boom')))
    expect(el.textContent).toBe('Science On a Sphere')
    expect(el.hasAttribute('data-tagline')).toBe(false)
  })

  it('sets the tagline as text, never markup', async () => {
    const el = subtitle()
    await bindSplashTagline(el, Promise.resolve('<img src=x onerror=alert(1)>'))
    expect(el.children).toHaveLength(0)
    expect(el.textContent).toBe('<img src=x onerror=alert(1)>')
  })

  it('still records the tagline for the VR scene when the page has no subtitle', async () => {
    await bindSplashTagline(null, Promise.resolve('Global Systems Laboratory'))
    expect(splashTagline()).toBe('Global Systems Laboratory')
  })
})

describe('the splash markup and stylesheet', () => {
  // The hold-back is split across three files; if one drifts, a
  // stalled read hides the line for good with every other test green.
  const html = readFileSync(resolve(process.cwd(), 'src/index.html'), 'utf8')
  const css = readFileSync(resolve(process.cwd(), 'src/styles/loading.css'), 'utf8')

  it('starts the subtitle held back, and never announced', () => {
    const tag = html.match(/<div class="loading-subtitle"[^>]*>/)?.[0] ?? ''
    expect(tag).toContain(`${SPLASH_TAGLINE_PENDING_ATTR}="pending"`)
    expect(tag).toContain('aria-live="off"')
  })

  it('hides it while pending, and reveals it by itself as a safety net', () => {
    const pending = css.match(/\.loading-subtitle\[data-tagline="pending"\]\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(pending).toMatch(/visibility:\s*hidden/)
    expect(pending).toMatch(/animation:\s*loading-subtitle-reveal\b[^;]*\bforwards/)
    const keyframes = css.match(/@keyframes loading-subtitle-reveal\s*\{([\s\S]*?)\}\s*\}/)?.[1] ?? ''
    expect(keyframes).toMatch(/visibility:\s*visible/)
    expect(keyframes).toMatch(/opacity:\s*0\.8/)
  })
})
