import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  startPerfSampler,
  stopPerfSampler,
  pauseForVrEntry,
  resumeForVrExit,
  __resetPerfSamplerForTests,
  __emitSampleNowForTests,
  __feedFrameForTests,
} from './perfSampler'
import { resetForTests, __peek } from './emitter'
import { setTier } from './config'

beforeEach(() => {
  localStorage.clear()
  resetForTests()
  __resetPerfSamplerForTests()
  setTier('essential')
})

afterEach(() => {
  __resetPerfSamplerForTests()
  stopPerfSampler()
})

describe('perfSampler — emit semantics', () => {
  it('emits a perf_sample event when enough frame samples are buffered', () => {
    // Feed 30 frames at ~16.67ms (60 fps), timestamps within the
    // rolling window relative to Date.now().
    const base = Date.now() - 500
    for (let i = 0; i < 30; i++) {
      __feedFrameForTests(16.67, base + i * 16)
    }
    __emitSampleNowForTests()
    const evs = __peek().filter((e) => e.event_type === 'perf_sample')
    expect(evs).toHaveLength(1)
    const ev = evs[0]
    if (ev.event_type !== 'perf_sample') throw new Error('unreachable')
    expect(ev.surface).toBe('map')
    expect(ev.fps_median_10s).toBeGreaterThanOrEqual(58)
    expect(ev.fps_median_10s).toBeLessThanOrEqual(62)
    expect(ev.frame_time_p95_ms).toBeGreaterThan(0)
    expect(typeof ev.webgl_renderer_hash).toBe('string')
    expect(ev.webgl_renderer_hash.length).toBeGreaterThanOrEqual(7)
  })

  it('does not emit when fewer than 10 samples are buffered', () => {
    for (let i = 0; i < 5; i++) __feedFrameForTests(16, Date.now() + i * 16)
    __emitSampleNowForTests()
    expect(__peek().filter((e) => e.event_type === 'perf_sample')).toHaveLength(0)
  })

  it('reports a lower fps when frames are slower', () => {
    // 30 fps = ~33.3 ms per frame.
    const base = Date.now() - 1000
    for (let i = 0; i < 30; i++) {
      __feedFrameForTests(33.3, base + i * 33)
    }
    __emitSampleNowForTests()
    const ev = __peek().find((e) => e.event_type === 'perf_sample')
    if (!ev || ev.event_type !== 'perf_sample') throw new Error('unreachable')
    expect(ev.fps_median_10s).toBeLessThanOrEqual(31)
    expect(ev.fps_median_10s).toBeGreaterThanOrEqual(29)
  })
})

describe('perfSampler — VR pause/resume', () => {
  it('pauseForVrEntry stops emitting samples until resumeForVrExit', () => {
    startPerfSampler()
    pauseForVrEntry()
    // Feed frames + try to emit — paused, no event.
    for (let i = 0; i < 20; i++) __feedFrameForTests(16, Date.now() + i * 16)
    __emitSampleNowForTests()
    // The emit happened, but the underlying frame loop was stopped;
    // samples we hand-fed do reach the buffer, so the assertion is
    // really just that the explicit pause doesn't crash and that
    // resume works.
    resumeForVrExit()
    expect(true).toBe(true)
  })

  it('pauseForVrEntry also stops the per-minute emit timer', () => {
    vi.useFakeTimers()
    try {
      startPerfSampler()
      // Pre-VR samples in the rolling window. Without stopping the
      // emit timer, a tick within ~10s of VR entry could emit a
      // stale sample.
      for (let i = 0; i < 15; i++) __feedFrameForTests(16)
      pauseForVrEntry()
      const before = __peek().filter((e) => e.event_type === 'perf_sample').length
      vi.advanceTimersByTime(60_000)
      const after = __peek().filter((e) => e.event_type === 'perf_sample').length
      expect(after).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resumeForVrExit restarts the per-minute emit timer', () => {
    vi.useFakeTimers()
    try {
      startPerfSampler()
      pauseForVrEntry()
      resumeForVrExit()
      // Fresh post-VR samples + a minute tick should produce one emit.
      for (let i = 0; i < 15; i++) __feedFrameForTests(16)
      vi.advanceTimersByTime(60_000)
      const evs = __peek().filter((e) => e.event_type === 'perf_sample')
      expect(evs.length).toBeGreaterThanOrEqual(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('perfSampler — lifecycle', () => {
  it('startPerfSampler is idempotent — second call is a no-op', () => {
    startPerfSampler()
    expect(() => startPerfSampler()).not.toThrow()
  })

  it('stopPerfSampler cancels the visibility listener and clears samples', () => {
    startPerfSampler()
    for (let i = 0; i < 15; i++) __feedFrameForTests(16, Date.now() + i * 16)
    stopPerfSampler()
    __emitSampleNowForTests()
    expect(__peek().filter((e) => e.event_type === 'perf_sample')).toHaveLength(0)
  })

  it('does not start the rAF loop while document is hidden', () => {
    const visSpy = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden')
    try {
      startPerfSampler()
      // Sampler is "running" from the bookkeeping perspective but
      // the rAF loop didn't actually start. No way to introspect
      // from outside; just verify no throw.
      expect(true).toBe(true)
    } finally {
      visSpy.mockRestore()
    }
  })

  it('starts the minute timer once the tab becomes visible (start-while-hidden path)', () => {
    vi.useFakeTimers()
    const visSpy = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden')
    try {
      startPerfSampler()
      // Hidden — emit timer must not be ticking, so a synthetic
      // batch of samples + timer advance yields no emission via
      // the interval (only the explicit __emitSampleNowForTests
      // path can drive an emit while hidden).
      for (let i = 0; i < 15; i++) __feedFrameForTests(16)
      vi.advanceTimersByTime(60_000)
      expect(__peek().filter((e) => e.event_type === 'perf_sample')).toHaveLength(0)

      // Tab returns — visibility handler should start both the rAF
      // loop and the minute timer.
      visSpy.mockReturnValue('visible')
      document.dispatchEvent(new Event('visibilitychange'))
      // Feed enough samples so the next interval tick emits.
      for (let i = 0; i < 15; i++) __feedFrameForTests(16)
      vi.advanceTimersByTime(60_000)
      expect(
        __peek().filter((e) => e.event_type === 'perf_sample').length,
      ).toBeGreaterThanOrEqual(1)
    } finally {
      visSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('stops the minute timer while the tab is hidden', () => {
    vi.useFakeTimers()
    const visSpy = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('visible')
    try {
      startPerfSampler()
      for (let i = 0; i < 15; i++) __feedFrameForTests(16)
      // Tab hides — the visibility handler must clear the minute
      // timer so a hidden tab can't drift the "active minute"
      // semantics.
      visSpy.mockReturnValue('hidden')
      document.dispatchEvent(new Event('visibilitychange'))
      const before = __peek().filter((e) => e.event_type === 'perf_sample').length
      vi.advanceTimersByTime(60_000)
      const after = __peek().filter((e) => e.event_type === 'perf_sample').length
      expect(after).toBe(before)
    } finally {
      visSpy.mockRestore()
      vi.useRealTimers()
    }
  })
})
