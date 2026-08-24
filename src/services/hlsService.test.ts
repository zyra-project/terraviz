import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HLSService } from './hlsService'

// ---------------------------------------------------------------------------
// Mock hls.js — we test HLSService logic, not the HLS library itself
// ---------------------------------------------------------------------------
// `on` records its handlers rather than discarding them, so a test can
// drive the real event order — MANIFEST_PARSED (which settles the load
// promise) and only then ERROR — which is the whole subject below.
const hlsMock = vi.hoisted(() => ({
  handlers: new Map<string, (e: string, d: unknown) => void>(),
  instance: null as null | { startLoad: ReturnType<typeof vi.fn>; recoverMediaError: ReturnType<typeof vi.fn> },
  reset(): void {
    this.handlers.clear()
    this.instance = null
  },
  fire(event: string, data?: unknown): void {
    this.handlers.get(event)?.(event, data)
  },
}))

vi.mock('hls.js', () => {
  const MockHls = Object.assign(
    // A `function` expression, not an arrow: this mock is constructed
    // with `new`, and an arrow has no [[Construct]]. No test reached
    // this path before, so the original arrow was never exercised.
    vi.fn(function () {
      const inst = {
        loadSource: vi.fn(),
        attachMedia: vi.fn(),
        destroy: vi.fn(),
        on: vi.fn((event: string, cb: (e: string, d: unknown) => void) => {
          hlsMock.handlers.set(event, cb)
        }),
        levels: [],
        currentLevel: 0,
        autoLevelCapping: -1,
        audioTracks: [],
        startLoad: vi.fn(),
        recoverMediaError: vi.fn(),
      }
      hlsMock.instance = inst
      return inst
    }),
    {
      isSupported: vi.fn().mockReturnValue(true),
      Events: {
        MANIFEST_PARSED: 'hlsManifestParsed',
        LEVEL_SWITCHED: 'hlsLevelSwitched',
        ERROR: 'hlsError',
      },
      ErrorTypes: {
        NETWORK_ERROR: 'networkError',
        MEDIA_ERROR: 'mediaError',
      },
    }
  )

  return { default: MockHls }
})

// ---------------------------------------------------------------------------
// HLSService — property defaults and lifecycle
// ---------------------------------------------------------------------------
describe('HLSService', () => {
  let svc: HLSService

  beforeEach(() => {
    svc = new HLSService()
  })

  it('getVideo() returns null before createVideo()', () => {
    expect(svc.getVideo()).toBeNull()
  })

  it('duration returns 0 when no video', () => {
    expect(svc.duration).toBe(0)
  })

  it('currentTime returns 0 when no video', () => {
    expect(svc.currentTime).toBe(0)
  })

  it('paused returns true when no video', () => {
    expect(svc.paused).toBe(true)
  })

  it('playbackRate returns 1 when no video', () => {
    expect(svc.playbackRate).toBe(1)
  })

  it('destroy() does not throw when nothing is loaded', () => {
    expect(() => svc.destroy()).not.toThrow()
  })

  it('setting currentTime on null video is a no-op', () => {
    expect(() => { svc.currentTime = 30 }).not.toThrow()
  })

  it('setting playbackRate on null video is a no-op', () => {
    expect(() => { svc.playbackRate = 2 }).not.toThrow()
  })

  it('pause() on null video is a no-op', () => {
    expect(() => svc.pause()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// HLSService.createVideo — DOM interaction
// ---------------------------------------------------------------------------
describe('HLSService.createVideo', () => {
  it('creates and returns an HTMLVideoElement', () => {
    const svc = new HLSService()
    const video = svc.createVideo()
    expect(video).toBeInstanceOf(HTMLVideoElement)
    expect(video.muted).toBe(true)
    expect(video.playsInline).toBe(true)
  })

  it('returns the same element on repeated calls', () => {
    const svc = new HLSService()
    const v1 = svc.createVideo()
    const v2 = svc.createVideo()
    expect(v1).toBe(v2)
  })

  it('getVideo() returns the element after createVideo()', () => {
    const svc = new HLSService()
    const video = svc.createVideo()
    expect(svc.getVideo()).toBe(video)
  })
})

// ---------------------------------------------------------------------------
// HLSService.destroy — cleans up the video element
// ---------------------------------------------------------------------------
describe('HLSService.destroy', () => {
  it('sets getVideo() back to null after destroy()', () => {
    const svc = new HLSService()
    svc.createVideo()
    expect(svc.getVideo()).not.toBeNull()
    svc.destroy()
    expect(svc.getVideo()).toBeNull()
  })

  it('resets property defaults after destroy()', () => {
    const svc = new HLSService()
    svc.createVideo()
    svc.destroy()
    expect(svc.duration).toBe(0)
    expect(svc.paused).toBe(true)
    expect(svc.playbackRate).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// HLSService.loadStream — rejects when HLS is unsupported
// ---------------------------------------------------------------------------
describe('HLSService.loadStream — unsupported browser', () => {
  it('rejects when neither hls.js nor native HLS is available', async () => {
    // Dynamically re-import after overriding isSupported
    const { default: Hls } = await import('hls.js')
    vi.mocked(Hls.isSupported).mockReturnValueOnce(false)

    const svc = new HLSService()
    const video = document.createElement('video')
    // canPlayType returns '' for mpegurl in happy-dom, triggering the else branch
    await expect(svc.loadStream('https://example.com/stream.m3u8', video))
      .rejects.toThrow('HLS is not supported')
  })
})

// ---------------------------------------------------------------------------
// Fatal errors after the load promise has settled
//
// `loadStream` resolves on MANIFEST_PARSED, which fires long before
// playback. Fatal errors after that were rejecting a promise nobody was
// holding — a silent no-op — so a stream that died mid-playback spent
// its retries and went quiet. These pin the two halves: before the
// promise settles it still rejects (the progressive-MP4 fallback in
// `datasetLoader` depends on that), and after, the failure reaches a
// handler instead of vanishing.
// ---------------------------------------------------------------------------

describe('HLSService fatal errors after load', () => {
  const NETWORK = { fatal: true, type: 'networkError', details: 'fragLoadError' }
  const MEDIA = { fatal: true, type: 'mediaError', details: 'bufferStalledError' }

  beforeEach(async () => {
    hlsMock.reset()
    const { default: Hls } = await import('hls.js')
    vi.mocked(Hls.isSupported).mockReturnValue(true)
  })

  /** Load a stream and settle it, returning the service and the load promise. */
  function loadAndSettle(svc: HLSService): Promise<void> {
    const video = document.createElement('video')
    const p = svc.loadStream('https://example.com/s.m3u8', video)
    hlsMock.fire('hlsManifestParsed', { levels: [] })
    return p
  }

  it('reports a post-load fatal error to the handler once retries are spent', async () => {
    const svc = new HLSService()
    const seen: unknown[] = []
    svc.onFatalError((e) => seen.push(e))
    await loadAndSettle(svc)

    // Three recoveries, then the failure is terminal.
    for (let i = 0; i < 4; i++) hlsMock.fire('hlsError', NETWORK)

    expect(hlsMock.instance?.startLoad).toHaveBeenCalledTimes(3)
    expect(seen).toEqual([{ type: 'networkError', details: 'fragLoadError' }])
  })

  it('stays silent while retries remain', async () => {
    const svc = new HLSService()
    const seen: unknown[] = []
    svc.onFatalError((e) => seen.push(e))
    await loadAndSettle(svc)

    for (let i = 0; i < 3; i++) hlsMock.fire('hlsError', NETWORK)

    // Recovery is in progress — not something to report yet.
    expect(hlsMock.instance?.startLoad).toHaveBeenCalledTimes(3)
    expect(seen).toEqual([])
  })

  it('reports a terminal media error too', async () => {
    const svc = new HLSService()
    const seen: unknown[] = []
    svc.onFatalError((e) => seen.push(e))
    await loadAndSettle(svc)

    for (let i = 0; i < 4; i++) hlsMock.fire('hlsError', MEDIA)

    expect(hlsMock.instance?.recoverMediaError).toHaveBeenCalledTimes(3)
    expect(seen).toEqual([{ type: 'mediaError', details: 'bufferStalledError' }])
  })

  it('still rejects when the failure lands before the promise settles', async () => {
    // The load-time contract `datasetLoader`'s MP4 fallback rests on.
    const svc = new HLSService()
    const seen: unknown[] = []
    svc.onFatalError((e) => seen.push(e))

    const video = document.createElement('video')
    const p = svc.loadStream('https://example.com/s.m3u8', video)
    for (let i = 0; i < 4; i++) hlsMock.fire('hlsError', NETWORK)

    await expect(p).rejects.toThrow('HLS network error after 3 retries')
    // Rejecting *is* the report at this point; it must not double up.
    expect(seen).toEqual([])
  })

  it('does not report a stream failure to a disposed panel', async () => {
    // `destroy()` calls `video.load()`, which can itself fire `error`.
    const svc = new HLSService()
    const seen: unknown[] = []
    svc.onFatalError((e) => seen.push(e))
    await loadAndSettle(svc)

    svc.destroy()
    for (let i = 0; i < 4; i++) hlsMock.fire('hlsError', NETWORK)

    expect(seen).toEqual([])
  })

  it('keeps reporting later failures, not just the first', async () => {
    // A panel that recovers and dies again is still a dead panel.
    const svc = new HLSService()
    const seen: unknown[] = []
    svc.onFatalError((e) => seen.push(e))
    await loadAndSettle(svc)

    for (let i = 0; i < 4; i++) hlsMock.fire('hlsError', NETWORK)
    hlsMock.fire('hlsError', NETWORK)

    expect(seen).toHaveLength(2)
  })

  it('is inert when no handler is registered', async () => {
    const svc = new HLSService()
    await loadAndSettle(svc)

    expect(() => {
      for (let i = 0; i < 4; i++) hlsMock.fire('hlsError', NETWORK)
    }).not.toThrow()
  })
})
