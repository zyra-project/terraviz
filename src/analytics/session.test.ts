import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initSession, emitSessionEnd, __resetSessionForTests } from './session'
import { resetForTests, __peek, emit } from './emitter'
import { setTier } from './config'
import type { LayerLoadedEvent } from '../types'

function layerLoaded(id = 'A'): LayerLoadedEvent {
  return {
    event_type: 'layer_loaded',
    layer_id: id,
    layer_source: 'network',
    slot_index: '0',
    trigger: 'browse',
    load_ms: 50,
  }
}

beforeEach(() => {
  localStorage.clear()
  resetForTests()
  __resetSessionForTests()
  setTier('essential')
})

afterEach(() => {
  __resetSessionForTests()
})

describe('session — initSession', () => {
  it('emits exactly one session_start with the expected fields', async () => {
    await initSession()
    const evs = __peek()
    const starts = evs.filter((e) => e.event_type === 'session_start')
    expect(starts).toHaveLength(1)
    const s = starts[0]
    if (s.event_type !== 'session_start') throw new Error('unreachable')
    expect(s.platform).toMatch(/^(web|desktop|mobile)$/)
    expect(s.os).toMatch(/^(mac|windows|linux|ios|android|unknown)$/)
    expect(s.locale.length).toBeGreaterThan(0)
    expect(s.viewport_class).toMatch(/^(xs|sm|md|lg|xl)$/)
    expect(s.aspect_class).toMatch(
      /^(portrait-tall|portrait|square|landscape|wide|ultrawide)$/,
    )
    expect(s.screen_class).toMatch(/^(mobile|tablet|1080p|2k|4k\+)$/)
    expect(s.build_channel).toMatch(/^(public|internal|canary)$/)
    expect(s.vr_capable).toMatch(/^(none|vr|ar|both)$/)
    expect(s.schema_version.length).toBeGreaterThan(0)
  })

  it('is idempotent — a second call does not emit a second session_start', async () => {
    await initSession()
    await initSession()
    const evs = __peek()
    const starts = evs.filter((e) => e.event_type === 'session_start')
    expect(starts).toHaveLength(1)
  })

  it('reports platform=web when __TAURI__ is absent (default happy-dom)', async () => {
    await initSession()
    const s = __peek().find((e) => e.event_type === 'session_start')
    if (!s || s.event_type !== 'session_start') throw new Error('unreachable')
    expect(s.platform).toBe('web')
  })

  it('reports platform=mobile when __TAURI__ is set and the OS looks mobile', async () => {
    const w = window as unknown as { __TAURI__?: unknown }
    w.__TAURI__ = { ping: 1 }
    const uaSpy = vi
      .spyOn(navigator, 'userAgent', 'get')
      .mockReturnValue(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      )
    try {
      await initSession()
      const s = __peek().find((e) => e.event_type === 'session_start')
      if (!s || s.event_type !== 'session_start') throw new Error('unreachable')
      expect(s.platform).toBe('mobile')
      expect(s.os).toBe('ios')
    } finally {
      delete w.__TAURI__
      uaSpy.mockRestore()
    }
  })

  it('reports platform=desktop when __TAURI__ is set and the OS looks desktop', async () => {
    const w = window as unknown as { __TAURI__?: unknown }
    w.__TAURI__ = { ping: 1 }
    const uaSpy = vi
      .spyOn(navigator, 'userAgent', 'get')
      .mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')
    try {
      await initSession()
      const s = __peek().find((e) => e.event_type === 'session_start')
      if (!s || s.event_type !== 'session_start') throw new Error('unreachable')
      expect(s.platform).toBe('desktop')
      expect(s.os).toBe('mac')
    } finally {
      delete w.__TAURI__
      uaSpy.mockRestore()
    }
  })

  it.each([
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'windows'],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', 'linux'],
    ['Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36', 'android'],
    ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15', 'ios'],
    ['Random other UA with no recognizable OS', 'unknown'],
  ])('classifies UA %s → os=%s', async (ua, expected) => {
    const uaSpy = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua)
    // userAgentData is optional on Navigator and typed as unknown on
    // non-Chromium engines; clearing it forces the UA-substring path.
    const nav = navigator as unknown as { userAgentData?: unknown }
    const prev = nav.userAgentData
    nav.userAgentData = undefined
    try {
      await initSession()
      const s = __peek().find((e) => e.event_type === 'session_start')
      if (!s || s.event_type !== 'session_start') throw new Error('unreachable')
      expect(s.os).toBe(expected)
    } finally {
      nav.userAgentData = prev
      uaSpy.mockRestore()
    }
  })

  it('classifies aspect as portrait-tall for tall phones', async () => {
    const wSpy = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390)
    const hSpy = vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844)
    try {
      await initSession()
      const s = __peek().find((e) => e.event_type === 'session_start')
      if (!s || s.event_type !== 'session_start') throw new Error('unreachable')
      expect(s.aspect_class).toBe('portrait-tall')
    } finally {
      wSpy.mockRestore()
      hSpy.mockRestore()
    }
  })

  it('classifies aspect as ultrawide for 32:9 monitors', async () => {
    const wSpy = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(5120)
    const hSpy = vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(1440)
    try {
      await initSession()
      const s = __peek().find((e) => e.event_type === 'session_start')
      if (!s || s.event_type !== 'session_start') throw new Error('unreachable')
      expect(s.aspect_class).toBe('ultrawide')
    } finally {
      wSpy.mockRestore()
      hSpy.mockRestore()
    }
  })

  it.each([
    [320, 'mobile'],
    [1024, 'tablet'],
    [1920, '1080p'],
    [2560, '2k'],
    [3840, '4k+'],
  ])('classifies screen.width %i → screen_class=%s', async (width, expected) => {
    const spy = vi.spyOn(screen, 'width', 'get').mockReturnValue(width)
    try {
      await initSession()
      const s = __peek().find((e) => e.event_type === 'session_start')
      if (!s || s.event_type !== 'session_start') throw new Error('unreachable')
      expect(s.screen_class).toBe(expected)
    } finally {
      spy.mockRestore()
    }
  })

  it('falls back to build_channel=public when __BUILD_CHANNEL__ is unset (test env)', async () => {
    await initSession()
    const s = __peek().find((e) => e.event_type === 'session_start')
    if (!s || s.event_type !== 'session_start') throw new Error('unreachable')
    // __BUILD_CHANNEL__ is a Vite define — not present in vitest,
    // so detectBuildChannel's catch branch returns 'public'.
    expect(s.build_channel).toBe('public')
  })
})

describe('session — emitSessionEnd', () => {
  it('emits one session_end with a non-negative duration and the emitted-event count', async () => {
    await initSession()
    // Emit a couple of events so event_count > 0.
    emit(layerLoaded('A'))
    emit(layerLoaded('B'))
    emitSessionEnd('pagehide')

    const evs = __peek()
    const ends = evs.filter((e) => e.event_type === 'session_end')
    expect(ends).toHaveLength(1)
    const e = ends[0]
    if (e.event_type !== 'session_end') throw new Error('unreachable')
    expect(e.exit_reason).toBe('pagehide')
    expect(e.duration_ms).toBeGreaterThanOrEqual(0)
    // session_start counts as an event too.
    expect(e.event_count).toBeGreaterThanOrEqual(3)
  })

  it('is idempotent — pagehide fired twice yields one session_end', async () => {
    await initSession()
    emitSessionEnd('pagehide')
    emitSessionEnd('pagehide')
    const evs = __peek()
    const ends = evs.filter((e) => e.event_type === 'session_end')
    expect(ends).toHaveLength(1)
  })

  it('pagehide on window triggers session_end exactly once', async () => {
    await initSession()
    window.dispatchEvent(new Event('pagehide'))
    window.dispatchEvent(new Event('pagehide'))
    const evs = __peek()
    const ends = evs.filter((e) => e.event_type === 'session_end')
    expect(ends).toHaveLength(1)
  })
})
