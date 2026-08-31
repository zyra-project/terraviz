// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { shareDataset, buildDatasetShareUrl } from './shareService'

describe('shareDataset', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('uses Web Share API when available', async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'share', { value: shareMock, writable: true, configurable: true })

    const result = await shareDataset({ title: 'Test', text: 'Hello', url: 'https://example.com' })
    expect(result).toBe(true)
    expect(shareMock).toHaveBeenCalledWith({ title: 'Test', text: 'Hello', url: 'https://example.com' })

    Object.defineProperty(navigator, 'share', { value: undefined, writable: true, configurable: true })
  })

  it('returns false when user cancels Web Share', async () => {
    const shareMock = vi.fn().mockRejectedValue(new DOMException('', 'AbortError'))
    Object.defineProperty(navigator, 'share', { value: shareMock, writable: true, configurable: true })

    const result = await shareDataset({ title: 'Test', text: 'Hello', url: 'https://example.com' })
    expect(result).toBe(false)

    Object.defineProperty(navigator, 'share', { value: undefined, writable: true, configurable: true })
  })

  it('falls back to clipboard when Web Share fails with non-cancel error', async () => {
    const shareMock = vi.fn().mockRejectedValue(new Error('NotAllowedError'))
    Object.defineProperty(navigator, 'share', { value: shareMock, writable: true, configurable: true })

    const clipboardMock = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: clipboardMock },
      writable: true,
      configurable: true,
    })

    const result = await shareDataset({ title: 'Test', text: 'Hello', url: 'https://example.com' })
    expect(result).toBe(true)
    expect(clipboardMock).toHaveBeenCalledWith('https://example.com')

    Object.defineProperty(navigator, 'share', { value: undefined, writable: true, configurable: true })
  })

  it('falls back to clipboard when Web Share API is absent', async () => {
    Object.defineProperty(navigator, 'share', { value: undefined, writable: true, configurable: true })

    const clipboardMock = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: clipboardMock },
      writable: true,
      configurable: true,
    })

    const result = await shareDataset({ title: 'Test', text: 'Hello', url: 'https://example.com' })
    expect(result).toBe(true)
    expect(clipboardMock).toHaveBeenCalledWith('https://example.com')
  })
})

describe('buildDatasetShareUrl', () => {
  it('names the dataset by slug so the copied link is human-readable', () => {
    const url = buildDatasetShareUrl({ id: '01KYK82VR6KDQK0915JNMQQ8RG', slug: 'north-america-smoke' })
    expect(url).toContain('/dataset/north-america-smoke')
  })

  it('falls back to the id when the row carries no slug', () => {
    const url = buildDatasetShareUrl({ id: 'INTERNAL_SOS_123' })
    expect(url).toContain('/dataset/INTERNAL_SOS_123')
  })

  it('falls back to the id when the slug is malformed', () => {
    // Underscores aren't in the slug alphabet — the synthesised
    // SOS_ONLY_* rows build theirs that way. Emitting it would
    // produce a link that wouldn't round-trip.
    const url = buildDatasetShareUrl({ id: 'SOS_ONLY_x', slug: 'not_a_valid_slug' })
    expect(url).toContain('/dataset/SOS_ONLY_x')
  })

  it('encodes special characters in the reference', () => {
    const url = buildDatasetShareUrl({ id: 'ID WITH SPACES' })
    expect(url).toContain('/dataset/ID%20WITH%20SPACES')
  })
})
