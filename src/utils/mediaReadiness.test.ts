// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, vi } from 'vitest'
import { playableStart, waitForDecodableFrame } from './mediaReadiness'

// ---------------------------------------------------------------------------
// waitForDecodableFrame
// ---------------------------------------------------------------------------

/**
 * The two engine behaviours this function sits between. A
 * `prerolling` element reaches `canplay` on its own; a `passive` one
 * only ever does so once something plays it, which is WebKitGTK and
 * which deadlocked a wait that ran before the caller's own `play()`.
 */
function fakeVideo(kind: 'prerolling' | 'passive' | 'dead', readyState = 0) {
  const listeners = new Map<string, Set<() => void>>()
  const video = {
    readyState,
    playCalls: 0,
    pauseCalls: 0,
    muted: false,
    pause() {
      video.pauseCalls++
    },
    addEventListener(type: string, fn: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
      if (type === 'canplay' && kind === 'prerolling') queueMicrotask(() => video.fire('canplay'))
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn)
    },
    fire(type: string) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn()
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0
    },
    play() {
      video.playCalls++
      if (kind === 'passive') queueMicrotask(() => video.fire('canplay'))
      return Promise.resolve()
    },
  }
  return video
}

describe('waitForDecodableFrame', () => {
  it('resolves without playing when the element is already decodable', async () => {
    const video = fakeVideo('prerolling', 4)
    await waitForDecodableFrame(video as unknown as HTMLVideoElement)
    expect(video.playCalls).toBe(0)
  })

  it('resolves on canplay from an engine that prerolls by itself', async () => {
    const video = fakeVideo('prerolling')
    await waitForDecodableFrame(video as unknown as HTMLVideoElement)
    expect(video.listenerCount('canplay')).toBe(0)
  })

  // The regression. A passive engine emits `canplay` only in response
  // to being played, so a wait that does not nudge never resolves and
  // the caller's own `play()` — which comes after this wait — can
  // never run. Measured on WebKitGTK: 88 s buffered, readyState 1.
  it('nudges a passive engine into prerolling rather than waiting for it', async () => {
    const video = fakeVideo('passive')
    await waitForDecodableFrame(video as unknown as HTMLVideoElement)
    expect(video.playCalls).toBe(1)
  })

  it('survives a rejected play() and still resolves if canplay arrives', async () => {
    const video = fakeVideo('prerolling')
    video.play = () => {
      video.playCalls++
      return Promise.reject(new Error('NotAllowedError'))
    }
    await waitForDecodableFrame(video as unknown as HTMLVideoElement)
    expect(video.playCalls).toBe(1)
  })

  // An output is a window on a projector and the nudge is not a
  // playback the operator asked for, so no autoplay policy should have
  // grounds to refuse it and nothing should come out of the speakers.
  it('mutes before nudging', async () => {
    const video = fakeVideo('passive')
    await waitForDecodableFrame(video as unknown as HTMLVideoElement)
    expect(video.muted).toBe(true)
  })

  // The multi-monitor output's case: it wants the pipeline prerolled
  // but its playhead belongs to `outputSync`, which decides play/pause
  // from the control window's transport.
  it('pauses on resolve when the caller asked it to', async () => {
    const video = fakeVideo('passive')
    await waitForDecodableFrame(video as unknown as HTMLVideoElement, { pauseWhenReady: true })
    expect(video.playCalls).toBe(1)
    expect(video.pauseCalls).toBe(1)
  })

  it('leaves the element playing when the caller did not', async () => {
    const video = fakeVideo('passive')
    await waitForDecodableFrame(video as unknown as HTMLVideoElement)
    expect(video.pauseCalls).toBe(0)
  })

  // A rejection means the nudge never took, so there is nothing to
  // pause — and pausing would hide the throw behind a second operation
  // that can itself fail.
  it('does not pause on the timeout path', async () => {
    vi.useFakeTimers()
    try {
      const video = fakeVideo('dead')
      const seen = waitForDecodableFrame(video as unknown as HTMLVideoElement, {
        timeoutMs: 20000,
        pauseWhenReady: true,
      }).catch((e: Error) => e)
      await vi.advanceTimersByTimeAsync(20000)
      await seen
      expect(video.pauseCalls).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects and unhooks when no frame ever becomes decodable', async () => {
    vi.useFakeTimers()
    try {
      const video = fakeVideo('dead')
      const settled = waitForDecodableFrame(video as unknown as HTMLVideoElement, { timeoutMs: 20000 })
      const seen = settled.catch((e: Error) => e)
      await vi.advanceTimersByTimeAsync(20000)
      const err = await seen
      expect((err as Error).message).toMatch(/took too long/)
      expect(video.listenerCount('canplay')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the timeout once a frame arrives', async () => {
    vi.useFakeTimers()
    try {
      const video = fakeVideo('passive')
      await waitForDecodableFrame(video as unknown as HTMLVideoElement, { timeoutMs: 20000 })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
// ---------------------------------------------------------------------------
// playableStart
// ---------------------------------------------------------------------------

function ranges(...pairs: Array<[number, number]>): TimeRanges {
  return {
    length: pairs.length,
    start: (i: number) => pairs[i][0],
    end: (i: number) => pairs[i][1],
  } as unknown as TimeRanges
}

describe('playableStart', () => {
  it('is zero when the asset is buffered from the start', () => {
    expect(playableStart(ranges([0, 94.1]))).toBe(0)
  })

  it('is zero before anything is buffered, so a fresh element is untouched', () => {
    expect(playableStart(ranges())).toBe(0)
  })

  // The regression. WebKitGTK measured [6.0, 94.1] on a 94.1 s asset;
  // rewinding to 0 parks a decodable element on a hole, which reads
  // exactly like a frozen first frame and reports nothing.
  it('skips a hole at the head rather than parking the playhead in it', () => {
    expect(playableStart(ranges([5.999999, 94.099999]))).toBeCloseTo(5.999999)
  })

  it('takes the earliest range when several are buffered', () => {
    expect(playableStart(ranges([40, 50], [6, 12]))).toBe(6)
  })

  it('still answers zero when a range merely touches it', () => {
    expect(playableStart(ranges([0, 0.5], [6, 94.1]))).toBe(0)
  })

  // A zero-length range at the origin contains no frame, so it is not
  // somewhere to park: `end > 0` is what rules it out.
  it('ignores an empty range at the origin', () => {
    expect(playableStart(ranges([0, 0], [6, 94.1]))).toBe(6)
  })
})
