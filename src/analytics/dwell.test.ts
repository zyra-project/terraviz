import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  startDwell,
  __resetDwellForTests,
  __activeDwellCount,
} from './dwell'
import { resetForTests, __peek } from './emitter'
import { setTier } from './config'

beforeEach(() => {
  localStorage.clear()
  resetForTests()
  __resetDwellForTests()
  // Tier B events need research mode.
  setTier('research')
})

afterEach(() => {
  __resetDwellForTests()
  vi.restoreAllMocks()
})

describe('startDwell — basic semantics', () => {
  it('emits a dwell event with the elapsed duration on stop', () => {
    const base = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(base)
    const handle = startDwell('chat')
    nowSpy.mockReturnValue(base + 4_500)
    handle.stop()

    const events = __peek().filter((e) => e.event_type === 'dwell')
    expect(events).toHaveLength(1)
    const e = events[0]
    if (e.event_type !== 'dwell') throw new Error('unreachable')
    expect(e.view_target).toBe('chat')
    expect(e.duration_ms).toBe(4500)
    nowSpy.mockRestore()
  })

  it('handles a dataset:<id> target verbatim', () => {
    const base = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(base)
    const handle = startDwell('dataset:INTERNAL_SOS_42')
    nowSpy.mockReturnValue(base + 1_200)
    handle.stop()

    const e = __peek().find((x) => x.event_type === 'dwell')
    if (!e || e.event_type !== 'dwell') throw new Error('unreachable')
    expect(e.view_target).toBe('dataset:INTERNAL_SOS_42')
    expect(e.duration_ms).toBe(1200)
    nowSpy.mockRestore()
  })

  it('is tier-gated — Essential / Off drop the event', () => {
    setTier('essential')
    const handle = startDwell('chat')
    handle.stop()
    expect(__peek().filter((e) => e.event_type === 'dwell')).toHaveLength(0)

    setTier('off')
    const handle2 = startDwell('chat')
    handle2.stop()
    expect(__peek().filter((e) => e.event_type === 'dwell')).toHaveLength(0)
  })

  it('a second stop() call is a no-op (no double-emit)', () => {
    const handle = startDwell('chat')
    handle.stop()
    handle.stop()
    expect(__peek().filter((e) => e.event_type === 'dwell')).toHaveLength(1)
  })

  it('elapsed() returns the current accumulated time without stopping', () => {
    const base = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(base)
    const handle = startDwell('browse')
    nowSpy.mockReturnValue(base + 750)
    expect(handle.elapsed()).toBe(750)
    nowSpy.mockReturnValue(base + 1_500)
    expect(handle.elapsed()).toBe(1500)
    // Nothing emitted yet.
    expect(__peek().filter((e) => e.event_type === 'dwell')).toHaveLength(0)
    handle.stop()
    nowSpy.mockRestore()
  })
})

describe('startDwell — multiple concurrent handles', () => {
  it('tracks every active handle independently', () => {
    const base = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(base)
    const chat = startDwell('chat')
    nowSpy.mockReturnValue(base + 100)
    const browse = startDwell('browse')
    nowSpy.mockReturnValue(base + 1_100)
    chat.stop()
    nowSpy.mockReturnValue(base + 2_100)
    browse.stop()

    const events = __peek().filter((e) => e.event_type === 'dwell')
    expect(events).toHaveLength(2)
    const byTarget = new Map<string, number>()
    for (const ev of events) {
      if (ev.event_type !== 'dwell') continue
      byTarget.set(ev.view_target, ev.duration_ms)
    }
    expect(byTarget.get('chat')).toBe(1100)
    expect(byTarget.get('browse')).toBe(2000)
    nowSpy.mockRestore()
  })

  it('__activeDwellCount reflects the number of running handles', () => {
    expect(__activeDwellCount()).toBe(0)
    const a = startDwell('chat')
    const b = startDwell('browse')
    expect(__activeDwellCount()).toBe(2)
    a.stop()
    expect(__activeDwellCount()).toBe(1)
    b.stop()
    expect(__activeDwellCount()).toBe(0)
  })
})

describe('startDwell — visibility transitions', () => {
  it('pauses accumulation when the tab is hidden, resumes on visible', () => {
    const base = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(base)
    const visSpy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')

    const handle = startDwell('chat')
    nowSpy.mockReturnValue(base + 500)

    // Tab hides — accumulator freezes at 500 ms.
    visSpy.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))

    // Two seconds pass while hidden — should not count.
    nowSpy.mockReturnValue(base + 2_500)

    // Tab returns — resume.
    visSpy.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))

    // Another 300 ms visible.
    nowSpy.mockReturnValue(base + 2_800)
    handle.stop()

    const e = __peek().find((x) => x.event_type === 'dwell')
    if (!e || e.event_type !== 'dwell') throw new Error('unreachable')
    expect(e.duration_ms).toBe(800) // 500 + 300, hidden time excluded
    nowSpy.mockRestore()
    visSpy.mockRestore()
  })

  it('starts paused when the tab is already hidden at startDwell time', () => {
    const base = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(base)
    const visSpy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')

    const handle = startDwell('chat')
    nowSpy.mockReturnValue(base + 5_000)
    handle.stop()

    const e = __peek().find((x) => x.event_type === 'dwell')
    if (!e || e.event_type !== 'dwell') throw new Error('unreachable')
    expect(e.duration_ms).toBe(0)
    nowSpy.mockRestore()
    visSpy.mockRestore()
  })
})

describe('startDwell — pagehide flush', () => {
  it('emits one dwell event per active handle when the page is hidden', () => {
    const base = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(base)
    startDwell('chat')
    startDwell('browse')
    nowSpy.mockReturnValue(base + 1_000)

    window.dispatchEvent(new Event('pagehide'))

    const events = __peek().filter((e) => e.event_type === 'dwell')
    expect(events).toHaveLength(2)
    nowSpy.mockRestore()
  })

  it('does not double-emit if a handle was already stopped before pagehide', () => {
    const handle = startDwell('chat')
    handle.stop()
    window.dispatchEvent(new Event('pagehide'))
    const events = __peek().filter((e) => e.event_type === 'dwell')
    expect(events).toHaveLength(1)
  })
})
