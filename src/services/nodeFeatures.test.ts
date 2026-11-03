// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The SPA's read of the node's feature toggles. One case reads an
 * answer; most of the rest are ways to fail, and each must come back
 * all-enabled — a node whose profile endpoint is slow, down, or not
 * there at all must not lose Orbit — and none may hold boot past the
 * wait's deadline.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultFeatures } from '../types/node-features'
import {
  fetchNodeFeatures,
  startNodeFeaturesRead,
  watchForOrbitWithdrawal,
} from './nodeFeatures'
import {
  isOrbitWithdrawn,
  resetOrbitAvailabilityForTests,
  withdrawOrbit,
} from './orbitAvailability'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const ORBIT_OFF = { profile: null, features: { ...defaultFeatures(), orbit: false } }

afterEach(() => {
  vi.useRealTimers()
  resetOrbitAvailabilityForTests()
})

describe('fetchNodeFeatures', () => {
  it('reads the toggles off the public node profile, bypassing the browser cache', async () => {
    const fetchFn = vi.fn(async (_path: string, _init?: RequestInit) => jsonResponse(ORBIT_OFF))
    const features = await fetchNodeFeatures({ fetchFn })
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/node-profile', expect.objectContaining({ cache: 'no-store' }))
    expect(features.orbit).toBe(false)
    expect(features.blog).toBe(true)
  })

  it('treats a payload without `features` (an older server) as all-enabled', async () => {
    const features = await fetchNodeFeatures({ fetchFn: async () => jsonResponse({ profile: null }) })
    expect(features).toEqual(defaultFeatures())
  })

  it('treats a non-2xx as all-enabled', async () => {
    const features = await fetchNodeFeatures({
      fetchFn: async () => jsonResponse({ features: { orbit: false } }, 500),
    })
    expect(features).toEqual(defaultFeatures())
  })

  it('treats an HTML body as all-enabled', async () => {
    const features = await fetchNodeFeatures({
      fetchFn: async () => new Response('<!doctype html><html></html>', { status: 200 }),
    })
    expect(features).toEqual(defaultFeatures())
  })

  it('treats a network failure as all-enabled', async () => {
    const features = await fetchNodeFeatures({
      fetchFn: async () => {
        throw new TypeError('Failed to fetch')
      },
    })
    expect(features).toEqual(defaultFeatures())
  })
})

describe('startNodeFeaturesRead().settle', () => {
  it('gives up at the deadline, aborts the request, and answers all-enabled', async () => {
    let signal: AbortSignal | undefined
    const read = startNodeFeaturesRead({
      fetchFn: (_path, init) => {
        signal = init?.signal ?? undefined
        return new Promise<Response>(() => {})
      },
    })
    expect(await read.settle(5)).toEqual(defaultFeatures())
    expect(signal?.aborted).toBe(true)
  })

  it('is bounded by its own timer when a body stalls after the headers', async () => {
    // Headers arrive, the body never finishes, and nothing honours the
    // abort — the wait must still end.
    const stalled = new Response(new ReadableStream({ start() {} }), { status: 200 })
    const read = startNodeFeaturesRead({ fetchFn: async () => stalled })
    expect(await read.settle(5)).toEqual(defaultFeatures())
  })

  it("measures the deadline from the wait, not from the request", async () => {
    vi.useFakeTimers()
    let answer!: (res: Response) => void
    const read = startNodeFeaturesRead({
      fetchFn: () => new Promise<Response>(resolve => {
        answer = resolve
      }),
    })
    // The catalog load takes longer than the deadline...
    await vi.advanceTimersByTimeAsync(10_000)
    const settled = read.settle(3_000)
    // ...and the node answers inside the deadline counted from here.
    await vi.advanceTimersByTimeAsync(1_000)
    answer(jsonResponse(ORBIT_OFF))
    expect((await settled).orbit).toBe(false)
  })

  it('gives every waiter the first answer', async () => {
    const read = startNodeFeaturesRead({ fetchFn: async () => jsonResponse(ORBIT_OFF) })
    const first = await read.settle()
    expect(await read.settle()).toBe(first)
  })
})

describe('watchForOrbitWithdrawal', () => {
  it('withdraws Orbit when a re-read says off, and then stops reading', async () => {
    vi.useFakeTimers()
    const fetchFn = vi.fn(async () => jsonResponse(ORBIT_OFF))
    watchForOrbitWithdrawal({ fetchFn, intervalMs: 1_000 })
    expect(isOrbitWithdrawn()).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(isOrbitWithdrawn()).toBe(true)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('does not withdraw on a failed or all-on re-read', async () => {
    vi.useFakeTimers()
    let call = 0
    const fetchFn = vi.fn(async () => {
      call++
      if (call === 1) throw new TypeError('Failed to fetch')
      return jsonResponse({ profile: null, features: defaultFeatures() })
    })
    watchForOrbitWithdrawal({ fetchFn, intervalMs: 1_000 })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(isOrbitWithdrawn()).toBe(false)
  })

  it('stops when Orbit is withdrawn by another path', async () => {
    vi.useFakeTimers()
    const fetchFn = vi.fn(async () => jsonResponse({ profile: null, features: defaultFeatures() }))
    watchForOrbitWithdrawal({ fetchFn, intervalMs: 1_000 })
    withdrawOrbit('chat')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('startNodeFeaturesRead().tagline', () => {
  it('reads the splash tagline from the same response as the toggles', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ profile: { orgName: 'GSL', logoUrl: null, tagline: '  Global Systems Laboratory ' }, features: {} }),
    )
    const read = startNodeFeaturesRead({ fetchFn })
    expect(await read.tagline).toBe('Global Systems Laboratory')
    await read.settle()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('answers null for no profile, no tagline, or one that is not text', async () => {
    for (const body of [
      { profile: null },
      { profile: { orgName: 'X', logoUrl: null } },
      { profile: { orgName: 'X', tagline: null } },
      { profile: { orgName: 'X', tagline: '   ' } },
      { profile: { orgName: 'X', tagline: 42 } },
    ]) {
      expect(await startNodeFeaturesRead({ fetchFn: async () => jsonResponse(body) }).tagline).toBeNull()
    }
  })

  it('answers null when a settle deadline aborts the read', async () => {
    const read = startNodeFeaturesRead({
      fetchFn: (_path, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    })
    await read.settle(5)
    expect(await read.tagline).toBeNull()
  })

  it('stays pending, without rejecting, when a fetch ignores the abort', async () => {
    const read = startNodeFeaturesRead({ fetchFn: () => new Promise<Response>(() => {}) })
    await read.settle(5)
    const outcome = await Promise.race([
      read.tagline.then(
        () => 'settled',
        () => 'rejected',
      ),
      new Promise(resolve => setTimeout(() => resolve('pending'), 20)),
    ])
    expect(outcome).toBe('pending')
  })

  it('answers null when the read fails', async () => {
    const failing = startNodeFeaturesRead({
      fetchFn: async () => {
        throw new TypeError('Failed to fetch')
      },
    })
    expect(await failing.tagline).toBeNull()
    const refused = startNodeFeaturesRead({ fetchFn: async () => jsonResponse({ profile: { tagline: 'X' } }, 500) })
    expect(await refused.tagline).toBeNull()
  })
})
