// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The loading screen's tagline: a node's own line replaces the
 * default, no line keeps it, and either way the held-back subtitle is
 * revealed — a subtitle left `pending` would only come back through
 * the CSS deadline, a beat late on every load.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { bindSplashTagline, resetSplashTaglineForTests, splashTagline } from './splashTagline'

function subtitle(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'loading-subtitle'
  el.setAttribute('data-i18n', 'loading.subtitle')
  el.setAttribute('data-tagline', 'pending')
  el.textContent = 'Science On a Sphere'
  return el
}

afterEach(() => resetSplashTaglineForTests())

describe('bindSplashTagline', () => {
  it("writes the node's tagline in, drops the i18n key, and reveals it", async () => {
    const el = subtitle()
    await bindSplashTagline(el, Promise.resolve('Global Systems Laboratory'))
    expect(el.textContent).toBe('Global Systems Laboratory')
    expect(el.hasAttribute('data-i18n')).toBe(false)
    expect(el.hasAttribute('data-tagline')).toBe(false)
    expect(splashTagline()).toBe('Global Systems Laboratory')
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
