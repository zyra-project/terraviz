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
  it('generates a /dataset/ path URL using current origin', () => {
    const url = buildDatasetShareUrl('INTERNAL_SOS_123')
    expect(url).toContain('/dataset/INTERNAL_SOS_123')
  })

  it('encodes special characters in dataset ID', () => {
    const url = buildDatasetShareUrl('ID WITH SPACES')
    expect(url).toContain('/dataset/ID%20WITH%20SPACES')
  })
})
