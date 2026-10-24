// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it, vi } from 'vitest'
import {
  CLOUD_MARGIN_MS,
  CLOUD_PERIOD_MS,
  CLOUD_RETRY_MS,
  createCloudRefresh,
  nextCloudCheckMs,
} from './cloudRefresh'
import { until } from '../test-utils'

const T0 = Date.parse('Sat, 24 Oct 2026 06:45:05 GMT')

describe('nextCloudCheckMs', () => {
  it('is due a period after the image was replaced, plus a margin', () => {
    expect(nextCloudCheckMs(T0, T0 + 3 * 60_000)).toBe(T0 + CLOUD_PERIOD_MS + CLOUD_MARGIN_MS)
  })

  it('aligns copies that loaded at different times', () => {
    // The point of timing from the image: two visitors, one image.
    expect(nextCloudCheckMs(T0, T0 + 60_000)).toBe(nextCloudCheckMs(T0, T0 + 9 * 60_000))
  })

  it('looks again soon when the replacement is late', () => {
    const late = T0 + CLOUD_PERIOD_MS + CLOUD_MARGIN_MS + 30_000
    expect(nextCloudCheckMs(T0, late)).toBe(late + CLOUD_RETRY_MS)
  })

  it('drops back to once a period when the producer has stopped', () => {
    const stopped = T0 + 4 * CLOUD_PERIOD_MS
    expect(nextCloudCheckMs(T0, stopped)).toBe(stopped + CLOUD_PERIOD_MS)
  })

  it('checks a period from now with nothing to align to', () => {
    expect(nextCloudCheckMs(null, T0)).toBe(T0 + CLOUD_PERIOD_MS)
  })
})

/** A server whose image can be replaced, answering like the upstream one. */
function server() {
  let version = 1
  let lastModified: string | null = new Date(T0).toUTCString()
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const headers = new Headers()
    if (lastModified) headers.set('Last-Modified', lastModified)
    return new Response(new Blob([`${url}#${version}`]), { status: 200, headers }) as Response & { init?: RequestInit }
  })
  return {
    fetchFn,
    replace(atMs: number) {
      version++
      lastModified = new Date(atMs).toUTCString()
    },
    dropLastModified() {
      lastModified = null
    },
  }
}

/** Decodes a blob to its text, so a test can see which image it got. */
const decode = async (blob: Blob) => (await blob.text()) as unknown as TexImageSource

describe('createCloudRefresh', () => {
  function harness(url = () => 'https://clouds.example/clouds_4096.jpg') {
    const srv = server()
    const timers: { fn: () => void; ms: number; cleared?: boolean }[] = []
    const images: unknown[] = []
    let now = T0 + 60_000
    const refresh = createCloudRefresh({
      url,
      onImage: img => images.push(img),
      fetchFn: srv.fetchFn,
      decode,
      nowMs: () => now,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms })
        return timers.length
      },
      clearTimer: handle => {
        timers[(handle as number) - 1].cleared = true
      },
    })
    return {
      srv,
      refresh,
      images,
      timers,
      advance(ms: number) {
        now += ms
      },
      /** Run the pending check and wait for it to schedule the next. */
      async fire() {
        const count = timers.length
        timers[count - 1].fn()
        await until(() => timers.length > count, 'the next check to be scheduled')
      },
    }
  }

  it('fetches the first image, asking the server rather than trusting the cache', async () => {
    const h = harness()
    expect(await h.refresh.first()).toBe('https://clouds.example/clouds_4096.jpg#1')
    expect(h.srv.fetchFn).toHaveBeenCalledWith('https://clouds.example/clouds_4096.jpg', { cache: 'no-cache', mode: 'cors' })
  })

  it('schedules its first check from the image, not from the page', async () => {
    const h = harness()
    await h.refresh.first()
    h.refresh.start()
    // Now is T0 + 1 min; the check is due at T0 + period + margin.
    expect(h.timers[0].ms).toBe(CLOUD_PERIOD_MS + CLOUD_MARGIN_MS - 60_000)
  })

  it('retimes a check started before the first image arrived', async () => {
    // What the scene does: it starts checking without waiting for the
    // first fetch, which then lands with the image's own time.
    const h = harness()
    h.refresh.start()
    expect(h.timers[0].ms).toBe(CLOUD_PERIOD_MS)
    await h.refresh.first()
    expect(h.timers[0].cleared).toBe(true)
    expect(h.timers[1].ms).toBe(CLOUD_PERIOD_MS + CLOUD_MARGIN_MS - 60_000)
  })

  it('never waits longer than a period and a margin, whatever the clock says', async () => {
    // A visitor's clock far behind puts the due time far in the future.
    // Unclamped, past 2^31 ms, `setTimeout` fires at once, and the page
    // revalidated back to back.
    const h = harness()
    await h.refresh.first()
    h.advance(-40 * 24 * 3600_000)
    h.refresh.start()
    expect(h.timers[0].ms).toBe(CLOUD_PERIOD_MS + CLOUD_MARGIN_MS)
  })

  it('hands on a replaced image, and only a replaced one', async () => {
    const h = harness()
    await h.refresh.first()
    h.refresh.start()

    // Not replaced yet: nothing new, and nothing decoded.
    h.advance(CLOUD_PERIOD_MS + CLOUD_MARGIN_MS)
    await h.fire()
    expect(h.images).toEqual([])

    h.srv.replace(T0 + CLOUD_PERIOD_MS)
    await h.fire()
    expect(h.images).toEqual(['https://clouds.example/clouds_4096.jpg#2'])
  })

  it('takes a different image when the frame changes size', async () => {
    let url = 'https://clouds.example/clouds_4096.jpg'
    const h = harness(() => url)
    await h.refresh.first()
    h.refresh.start()
    url = 'https://clouds.example/clouds_8192.jpg'
    await h.fire()
    expect(h.images).toEqual(['https://clouds.example/clouds_8192.jpg#1'])
  })

  it('re-decodes every time when the server sends no Last-Modified', async () => {
    const h = harness()
    h.srv.dropLastModified()
    await h.refresh.first()
    h.refresh.start()
    expect(h.timers[0].ms).toBe(CLOUD_PERIOD_MS)
    await h.fire()
    expect(h.images).toHaveLength(1)
  })

  it('keeps the current image, and keeps checking, through a failed fetch', async () => {
    const h = harness()
    await h.refresh.first()
    h.refresh.start()
    h.srv.fetchFn.mockRejectedValueOnce(new Error('offline'))
    await h.fire()
    expect(h.images).toEqual([])
    expect(h.timers).toHaveLength(2)
  })

  it('resolves null for a first image that will not load', async () => {
    const h = harness()
    h.srv.fetchFn.mockResolvedValueOnce(new Response('', { status: 503 }))
    expect(await h.refresh.first()).toBeNull()
  })

  it('stops scheduling once stopped', async () => {
    const h = harness()
    await h.refresh.first()
    h.refresh.start()
    h.refresh.stop()
    h.timers[0].fn()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.timers).toHaveLength(1)
    expect(h.images).toEqual([])
  })
})
