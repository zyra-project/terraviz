import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __resetPacingForTests,
  retryAfterMs,
  weblateFetch,
} from './weblate-client'

const res = (status: number, headers: Record<string, string> = {}): Response =>
  new Response('body', { status, headers })

describe('weblate-client', () => {
  beforeEach(() => {
    __resetPacingForTests()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('weblateFetch', () => {
    it('returns immediately on a non-throttled response', async () => {
      const fetchMock = vi.fn().mockResolvedValue(res(200))
      vi.stubGlobal('fetch', fetchMock)
      const r = await weblateFetch('https://example/api/x/')
      expect(r.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('retries a 429 (honoring Retry-After) then returns success', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(res(429, { 'retry-after': '0' }))
        .mockResolvedValueOnce(res(200))
      vi.stubGlobal('fetch', fetchMock)
      const r = await weblateFetch('https://example/api/x/', { method: 'POST' })
      expect(r.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('retries 503 too, and gives up after maxRetries returning the last response', async () => {
      const fetchMock = vi.fn().mockResolvedValue(res(503, { 'retry-after': '0' }))
      vi.stubGlobal('fetch', fetchMock)
      const r = await weblateFetch('https://example/api/x/', undefined, 2)
      expect(r.status).toBe(503)
      // 1 initial + 2 retries = 3 total.
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })
  })

  describe('retryAfterMs', () => {
    it('parses a delay-seconds value', () => {
      expect(retryAfterMs('30')).toBe(30_000)
      expect(retryAfterMs('0')).toBe(0)
    })

    it('parses an HTTP-date value relative to now', () => {
      const now = Date.parse('2026-06-14T06:00:00Z')
      expect(retryAfterMs('Sun, 14 Jun 2026 06:00:10 GMT', now)).toBe(10_000)
    })

    it('clamps a past date to zero', () => {
      const now = Date.parse('2026-06-14T06:00:00Z')
      expect(retryAfterMs('Sun, 14 Jun 2026 05:59:00 GMT', now)).toBe(0)
    })

    it('returns null when absent or unparseable', () => {
      expect(retryAfterMs(null)).toBeNull()
      expect(retryAfterMs('soon')).toBeNull()
    })
  })
})
