// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The dataset browser's subtitle: a node's own line replaces the
 * translated default, as the node's text; no line, or a failed read,
 * leaves the default exactly as it was.
 */

import { describe, expect, it } from 'vitest'
import { bindBrowseSubtitle } from './browseSubtitle'

const DEFAULT = 'Browse environmental datasets from NOAA Science On a Sphere'

function subtitle(): HTMLElement {
  const el = document.createElement('div')
  el.className = 'browse-subtitle'
  el.setAttribute('data-i18n', 'browse.subtitle')
  el.textContent = DEFAULT
  return el
}

describe('bindBrowseSubtitle', () => {
  it("writes the node's line as text, in no particular language or direction", async () => {
    const el = subtitle()
    await bindBrowseSubtitle(el, Promise.resolve(" Browse datasets from NOAA's Global Systems Laboratory "))
    expect(el.textContent).toBe("Browse datasets from NOAA's Global Systems Laboratory")
    expect(el.hasAttribute('data-i18n')).toBe(false)
    expect(el.getAttribute('lang')).toBe('')
    expect(el.getAttribute('dir')).toBe('auto')
  })

  it('leaves the default for no line, a blank one, or a failed read', async () => {
    for (const value of [Promise.resolve(null), Promise.resolve('   '), Promise.reject(new Error('boom'))]) {
      const el = subtitle()
      await bindBrowseSubtitle(el, value)
      expect(el.textContent).toBe(DEFAULT)
      expect(el.getAttribute('data-i18n')).toBe('browse.subtitle')
      expect(el.hasAttribute('lang')).toBe(false)
    }
  })

  it('sets the line as text, never markup', async () => {
    const el = subtitle()
    await bindBrowseSubtitle(el, Promise.resolve('<b>Bold</b>'))
    expect(el.children).toHaveLength(0)
    expect(el.textContent).toBe('<b>Bold</b>')
  })
})
