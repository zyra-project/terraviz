// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, beforeEach } from 'vitest'
import { getEmbedMode, getEmbedShowChat, applyEmbedMode } from './embedMode'

function setUrl(search: string): void {
  window.history.replaceState({}, '', `/${search}`)
}

describe('embedMode · getEmbedMode', () => {
  beforeEach(() => {
    setUrl('')
  })

  it('returns false when the embed param is absent', () => {
    expect(getEmbedMode()).toBe(false)
  })

  it('returns true when ?embed=1', () => {
    setUrl('?embed=1')
    expect(getEmbedMode()).toBe(true)
  })

  it('returns true when ?embed (empty value)', () => {
    setUrl('?embed')
    expect(getEmbedMode()).toBe(true)
  })

  it('returns false when ?embed=false', () => {
    setUrl('?embed=false')
    expect(getEmbedMode()).toBe(false)
  })

  it('returns false when ?embed=0', () => {
    setUrl('?embed=0')
    expect(getEmbedMode()).toBe(false)
  })

  it('is case-insensitive for false/0 opt-outs', () => {
    setUrl('?embed=False')
    expect(getEmbedMode()).toBe(false)
  })

  it('composes with the dataset and catalog flags', () => {
    setUrl('?dataset=INTERNAL_SOS_123&embed=1')
    expect(getEmbedMode()).toBe(true)
    setUrl('?catalog=true&embed=1')
    expect(getEmbedMode()).toBe(true)
  })
})

describe('embedMode · getEmbedShowChat', () => {
  beforeEach(() => {
    setUrl('')
  })

  it('returns false outside embed mode even with ?chat=1', () => {
    setUrl('?chat=1')
    expect(getEmbedShowChat()).toBe(false)
  })

  it('returns false in bare embed mode', () => {
    setUrl('?embed=1')
    expect(getEmbedShowChat()).toBe(false)
  })

  it('returns true with ?embed=1&chat=1', () => {
    setUrl('?embed=1&chat=1')
    expect(getEmbedShowChat()).toBe(true)
  })

  it('returns false with ?embed=1&chat=0', () => {
    setUrl('?embed=1&chat=0')
    expect(getEmbedShowChat()).toBe(false)
  })
})

describe('embedMode · applyEmbedMode', () => {
  beforeEach(() => {
    setUrl('')
    document.body.className = ''
  })

  it('adds no classes and returns false when embed mode is off', () => {
    expect(applyEmbedMode()).toBe(false)
    expect(document.body.classList.contains('embed-mode')).toBe(false)
  })

  it('adds the embed-mode class and returns true when ?embed=1', () => {
    setUrl('?embed=1')
    expect(applyEmbedMode()).toBe(true)
    expect(document.body.classList.contains('embed-mode')).toBe(true)
    expect(document.body.classList.contains('embed-show-chat')).toBe(false)
  })

  it('adds embed-show-chat when ?embed=1&chat=1', () => {
    setUrl('?embed=1&chat=1')
    applyEmbedMode()
    expect(document.body.classList.contains('embed-mode')).toBe(true)
    expect(document.body.classList.contains('embed-show-chat')).toBe(true)
  })

  it('is idempotent', () => {
    setUrl('?embed=1')
    applyEmbedMode()
    applyEmbedMode()
    expect(document.body.classList.value.split(/\s+/).filter(c => c === 'embed-mode')).toHaveLength(1)
  })
})
