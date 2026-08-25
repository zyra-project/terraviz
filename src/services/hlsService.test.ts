import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HLSService, measuredBandwidthBps, selectRendition } from './hlsService'

// ---------------------------------------------------------------------------
// Mock hls.js — we test HLSService logic, not the HLS library itself
// ---------------------------------------------------------------------------
// `on` records its handlers rather than discarding them, so a test can
// drive the real event order — MANIFEST_PARSED (which settles the load
// promise) and only then ERROR — which is the whole subject below.
const hlsMock = vi.hoisted(() => ({
  handlers: new Map<string, (e: string, d: unknown) => void>(),
  instance: null as null | {
    startLoad: ReturnType<typeof vi.fn>
    recoverMediaError: ReturnType<typeof vi.fn>
    levels: Array<{ width: number; height: number; bitrate: number; details?: { totalduration: number } }>
    currentLevel: number
    nextLevel: number
    autoLevelCapping: number
  },
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
        levels: [] as Array<{ width: number; height: number; bitrate: number; details?: { totalduration: number } }>,
        currentLevel: 0,
        nextLevel: -1,
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
        FRAG_LOADED: 'hlsFragLoaded',
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

// ---------------------------------------------------------------------------
// The handler is registered late, so a failure can precede it
//
// `onFatalError` cannot be called until `loadVideoDataset` returns, and
// that is well after the load promise settles — the loader still waits
// for `canplay` first. A stream dying on its first fragment dies inside
// that window.
// ---------------------------------------------------------------------------

describe('HLSService fatal errors before a handler exists', () => {
  const NETWORK = { fatal: true, type: 'networkError', details: 'fragLoadError' }

  beforeEach(async () => {
    hlsMock.reset()
    const { default: Hls } = await import('hls.js')
    vi.mocked(Hls.isSupported).mockReturnValue(true)
  })

  it('delivers a failure that landed before the handler was registered', async () => {
    const svc = new HLSService()
    const video = document.createElement('video')
    const p = svc.loadStream('https://example.com/s.m3u8', video)
    hlsMock.fire('hlsManifestParsed', { levels: [] })
    await p

    // The window: settled, but the caller is still awaiting `canplay`.
    for (let i = 0; i < 4; i++) hlsMock.fire('hlsError', NETWORK)

    const seen: unknown[] = []
    svc.onFatalError((e) => seen.push(e))
    expect(seen).toEqual([{ type: 'networkError', details: 'fragLoadError' }])
  })

  it('holds the first failure, not the last', async () => {
    // Later terminal errors are usually cascades of the first.
    const svc = new HLSService()
    const video = document.createElement('video')
    const p = svc.loadStream('https://example.com/s.m3u8', video)
    hlsMock.fire('hlsManifestParsed', { levels: [] })
    await p

    for (let i = 0; i < 4; i++) hlsMock.fire('hlsError', NETWORK)
    hlsMock.fire('hlsError', { fatal: true, type: 'mediaError', details: 'later' })

    const seen: unknown[] = []
    svc.onFatalError((e) => seen.push(e))
    expect(seen).toEqual([{ type: 'networkError', details: 'fragLoadError' }])
  })

  it('delivers a held failure only once', async () => {
    const svc = new HLSService()
    const video = document.createElement('video')
    const p = svc.loadStream('https://example.com/s.m3u8', video)
    hlsMock.fire('hlsManifestParsed', { levels: [] })
    await p
    for (let i = 0; i < 4; i++) hlsMock.fire('hlsError', NETWORK)

    svc.onFatalError(() => { /* first registration drains it */ })
    const seen: unknown[] = []
    svc.onFatalError((e) => seen.push(e))
    expect(seen).toEqual([])
  })

  it('does not deliver a held failure to a disposed panel', async () => {
    const svc = new HLSService()
    const video = document.createElement('video')
    const p = svc.loadStream('https://example.com/s.m3u8', video)
    hlsMock.fire('hlsManifestParsed', { levels: [] })
    await p
    for (let i = 0; i < 4; i++) hlsMock.fire('hlsError', NETWORK)

    svc.destroy()
    const seen: unknown[] = []
    svc.onFatalError((e) => seen.push(e))
    expect(seen).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Safari's native HLS path
//
// A different lifecycle from hls.js: a persistent DOM listener rather
// than a library callback. It is also the iOS path, so it carries the
// devices least able to absorb a stream failure quietly.
// ---------------------------------------------------------------------------

describe('HLSService native HLS path', () => {
  /** Force the native branch: hls.js unsupported, canPlayType truthy. */
  async function nativeVideo(): Promise<HTMLVideoElement> {
    const { default: Hls } = await import('hls.js')
    vi.mocked(Hls.isSupported).mockReturnValue(false)
    const video = document.createElement('video')
    video.canPlayType = () => 'maybe'
    return video
  }

  it('reports an error that arrives after the stream loaded', async () => {
    const svc = new HLSService()
    const video = await nativeVideo()
    const p = svc.loadStream('https://example.com/s.m3u8', video)
    video.dispatchEvent(new Event('loadedmetadata'))
    await p

    const seen: unknown[] = []
    svc.onFatalError((e) => seen.push(e))
    video.dispatchEvent(new Event('error'))

    expect(seen).toEqual([{ type: 'native', details: 'nativeHlsError' }])
  })

  it('still rejects when the error arrives before load', async () => {
    const svc = new HLSService()
    const video = await nativeVideo()
    const p = svc.loadStream('https://example.com/s.m3u8', video)
    video.dispatchEvent(new Event('error'))

    await expect(p).rejects.toThrow('Native HLS load failed')
  })

  it('keeps listening past the first error, unlike a `once` listener', async () => {
    // The listener is deliberately not `once`: on this path it is the
    // only report a dying stream has.
    const svc = new HLSService()
    const video = await nativeVideo()
    const p = svc.loadStream('https://example.com/s.m3u8', video)
    video.dispatchEvent(new Event('loadedmetadata'))
    await p

    const seen: unknown[] = []
    svc.onFatalError((e) => seen.push(e))
    video.dispatchEvent(new Event('error'))
    video.dispatchEvent(new Event('error'))

    expect(seen).toHaveLength(2)
  })

  it('goes quiet once the panel is disposed', async () => {
    const svc = new HLSService()
    const video = await nativeVideo()
    const p = svc.loadStream('https://example.com/s.m3u8', video)
    video.dispatchEvent(new Event('loadedmetadata'))
    await p

    const seen: unknown[] = []
    svc.onFatalError((e) => seen.push(e))
    svc.destroy()
    video.dispatchEvent(new Event('error'))

    expect(seen).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// loadDirect — the progressive MP4 a failed HLS stream falls back *to*
// ---------------------------------------------------------------------------

describe('HLSService.loadDirect', () => {
  it('reports an error that arrives after the file loaded', async () => {
    const svc = new HLSService()
    const video = document.createElement('video')
    const p = svc.loadDirect('https://example.com/v.mp4', video)
    video.dispatchEvent(new Event('loadedmetadata'))
    await p

    const seen: unknown[] = []
    svc.onFatalError((e) => seen.push(e))
    video.dispatchEvent(new Event('error'))

    expect(seen).toEqual([{ type: 'native', details: 'mp4ErrorAfterLoad' }])
  })

  it('still rejects when the error arrives before load', async () => {
    const svc = new HLSService()
    const video = document.createElement('video')
    const p = svc.loadDirect('https://example.com/v.mp4', video)
    video.dispatchEvent(new Event('error'))

    await expect(p).rejects.toThrow('Failed to load MP4 directly')
  })

  it('holds a post-load failure until a handler arrives', async () => {
    const svc = new HLSService()
    const video = document.createElement('video')
    const p = svc.loadDirect('https://example.com/v.mp4', video)
    video.dispatchEvent(new Event('loadedmetadata'))
    await p
    video.dispatchEvent(new Event('error'))

    const seen: unknown[] = []
    svc.onFatalError((e) => seen.push(e))
    expect(seen).toEqual([{ type: 'native', details: 'mp4ErrorAfterLoad' }])
  })
})

// ---------------------------------------------------------------------------
// A rejected load is the caller's failure, not a later one
//
// `datasetLoader` catches a `loadStream` rejection and falls back to the
// progressive MP4 through the *same* service and video, and `loadDirect`
// does not tear the hls.js instance down. The abandoned stream keeps
// emitting, and reporting that would condemn a healthy fallback.
// ---------------------------------------------------------------------------

describe('HLSService after a rejected load', () => {
  const NETWORK = { fatal: true, type: 'networkError', details: 'fragLoadError' }

  beforeEach(async () => {
    hlsMock.reset()
    const { default: Hls } = await import('hls.js')
    vi.mocked(Hls.isSupported).mockReturnValue(true)
  })

  it('ignores later errors from a stream whose load already rejected', async () => {
    const svc = new HLSService()
    const video = document.createElement('video')
    const p = svc.loadStream('https://example.com/s.m3u8', video)

    // Never reaches MANIFEST_PARSED — the load fails outright.
    for (let i = 0; i < 4; i++) hlsMock.fire('hlsError', NETWORK)
    await expect(p).rejects.toThrow('HLS network error')

    // The abandoned instance is still attached and still emitting.
    for (let i = 0; i < 4; i++) hlsMock.fire('hlsError', NETWORK)

    const seen: unknown[] = []
    svc.onFatalError((e) => seen.push(e))
    expect(seen).toEqual([])
  })

  it('still reports a failure of the MP4 the caller fell back to', async () => {
    // The fallback itself dying is a real terminal failure.
    const svc = new HLSService()
    const video = document.createElement('video')
    const p = svc.loadStream('https://example.com/s.m3u8', video)
    for (let i = 0; i < 4; i++) hlsMock.fire('hlsError', NETWORK)
    await expect(p).rejects.toThrow('HLS network error')

    const direct = svc.loadDirect('https://example.com/v.mp4', video)
    video.dispatchEvent(new Event('loadedmetadata'))
    await direct

    const seen: unknown[] = []
    svc.onFatalError((e) => seen.push(e))
    video.dispatchEvent(new Event('error'))

    expect(seen).toEqual([{ type: 'native', details: 'mp4ErrorAfterLoad' }])
  })
})

// ---------------------------------------------------------------------------
// measuredBandwidthBps — reading a transfer rate off one fragment
// ---------------------------------------------------------------------------
// The figures below are the ones measured in the browser against a
// reproduction of the catalog's fragment layout (a 0.2 s leading
// fragment ahead of a 2.23 s one). They are what hls.js's own sampler
// gets wrong, so they are worth pinning down here.
describe('measuredBandwidthBps', () => {
  const stats = (loaded: number, first: number, end: number) =>
    ({ loaded, loading: { start: 0, first, end } })

  it('measures from first byte to last, not from request start', () => {
    // 100_000 B over 100 ms of transfer = 8 Mbps. Counting the 400 ms
    // of latency ahead of it would report 1.6 Mbps instead.
    expect(measuredBandwidthBps(stats(100_000, 400, 500))).toBeCloseTo(8_000_000, 0)
  })

  it('reports the real rate where hls.js’s 50 ms floor would not', () => {
    // The reproduction: a 49_258 B probe fragment that transferred in
    // 4 ms. hls.js records 49_258 * 8 / 0.05 = 7.88 Mbps and pins the
    // stream to the lowest rung; the transfer actually ran at ~98 Mbps.
    const measured = measuredBandwidthBps(stats(49_258, 0, 4))!
    expect(measured).toBeCloseTo(98_516_000, 0)
    expect(measured).toBeGreaterThan(49_258 * 8 / 0.05)
  })

  it('clamps a cached sub-millisecond load rather than discarding it', () => {
    // The reported bug was measured with the asset already cached, so
    // this path has to yield a fast answer, not no answer.
    const measured = measuredBandwidthBps(stats(49_258, 12, 12))
    expect(measured).not.toBeNull()
    expect(measured!).toBeGreaterThan(100_000_000)
  })

  it('falls back to request start when no first-byte time was recorded', () => {
    expect(measuredBandwidthBps(stats(100_000, 0, 100))).toBeCloseTo(8_000_000, 0)
  })

  it('returns null when there is nothing to measure', () => {
    expect(measuredBandwidthBps(stats(0, 0, 100))).toBeNull()
    expect(measuredBandwidthBps(stats(NaN, 0, 100))).toBeNull()
    expect(measuredBandwidthBps(stats(100, 0, NaN))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// selectRendition — which rung the measured rate can afford
// ---------------------------------------------------------------------------
describe('selectRendition', () => {
  // The ladder from the reported dataset, cheapest first.
  const LADDER = [4_000_000, 8_000_000, 25_000_000]

  it('takes the top rung on a fast link', () => {
    expect(selectRendition(LADDER, 400_000_000, -1)).toBe(2)
  })

  it('takes the floor on a link that affords nothing above it', () => {
    // ~3 Mbps measured: even the 4 Mbps rung is unaffordable, but
    // playing the cheapest is better than playing nothing.
    expect(selectRendition(LADDER, 2_800_000, -1)).toBe(0)
  })

  it('leaves headroom rather than picking a rung it exactly matches', () => {
    // 25 Mbps measured cannot carry the 25 Mbps rung with margin.
    expect(selectRendition(LADDER, 25_000_000, -1)).toBe(1)
    expect(selectRendition(LADDER, 31_250_000, -1)).toBe(2)
  })

  it('never exceeds the mobile screen-size cap', () => {
    // A fast phone still must not decode the 4K rung.
    expect(selectRendition(LADDER, 400_000_000, 1)).toBe(1)
    expect(selectRendition(LADDER, 400_000_000, 0)).toBe(0)
  })

  it('falls back to the cheapest rung within the cap', () => {
    expect(selectRendition(LADDER, 1_000, 1)).toBe(0)
  })

  it('picks by bitrate, not by array position', () => {
    // Guards the selection against an unsorted level array.
    expect(selectRendition([25_000_000, 4_000_000, 8_000_000], 400_000_000, -1)).toBe(0)
    expect(selectRendition([25_000_000, 4_000_000, 8_000_000], 12_000_000, -1)).toBe(2)
  })

  it('returns -1 when there are no levels', () => {
    expect(selectRendition([], 400_000_000, -1)).toBe(-1)
  })
})

// ---------------------------------------------------------------------------
// Holding a rendition for a short looping asset
//
// The defect this covers: a 4096x2048 source decoding at 1440x720 on a
// gigabit link with the asset cached, and never stepping up — because
// hls.js's ABR cannot converge on a 2-3 s loop of one or two fragments.
// ---------------------------------------------------------------------------

describe('HLSService rendition hold', () => {
  // The ladder and fragment layout from the reported dataset.
  const LADDER = [
    { width: 1440, height: 720, bitrate: 4_000_000 },
    { width: 2160, height: 1080, bitrate: 8_000_000 },
    { width: 4096, height: 2048, bitrate: 25_000_000 },
  ]
  const SHORT = { totalduration: 2.433 }

  /** A FRAG_LOADED payload for the throwaway probe fragment. */
  const probe = (loaded: number, ms: number, level = 0) => ({
    frag: { level, stats: { loaded, loading: { start: 0, first: 0, end: ms } } },
  })

  const armed = async (
    levels: Array<{ width: number; height: number; bitrate: number }>,
    details: { totalduration: number } | undefined,
    cap = -1
  ) => {
    hlsMock.reset()
    const { default: Hls } = await import('hls.js')
    vi.mocked(Hls.isSupported).mockReturnValue(true)
    const svc = new HLSService()
    const p = svc.loadStream('https://example.com/s.m3u8', document.createElement('video'))
    hlsMock.instance!.levels = levels.map(l => ({ ...l, details }))
    hlsMock.instance!.autoLevelCapping = cap
    hlsMock.fire('hlsManifestParsed', { levels })
    await p
    return svc
  }

  it('holds the top rung when the probe transferred fast', async () => {
    await armed(LADDER, SHORT)
    // 49_258 B in 4 ms — the measurement hls.js floors to 7.9 Mbps.
    hlsMock.fire('hlsFragLoaded', probe(49_258, 4))
    expect(hlsMock.instance!.nextLevel).toBe(2)
  })

  it('holds the floor when the probe transferred slowly', async () => {
    await armed(LADDER, SHORT)
    // The same fragment over a ~3 Mbps link.
    hlsMock.fire('hlsFragLoaded', probe(49_258, 145))
    expect(hlsMock.instance!.nextLevel).toBe(0)
  })

  it('respects the mobile screen-size cap', async () => {
    await armed(LADDER, SHORT, 1)
    hlsMock.fire('hlsFragLoaded', probe(49_258, 4))
    expect(hlsMock.instance!.nextLevel).toBe(1)
  })

  it('chooses once and ignores later fragments', async () => {
    await armed(LADDER, SHORT)
    hlsMock.fire('hlsFragLoaded', probe(49_258, 4))
    expect(hlsMock.instance!.nextLevel).toBe(2)
    // A later, slower fragment must not re-open the decision: the asset
    // is buffered by now and a switch would only flip resolution
    // part-way through the loop.
    hlsMock.fire('hlsFragLoaded', probe(49_258, 500))
    expect(hlsMock.instance!.nextLevel).toBe(2)
  })

  it('leaves a long asset to hls.js', async () => {
    // Long streams have the fragments ABR needs, so nothing is held.
    await armed(LADDER, { totalduration: 3600 })
    hlsMock.fire('hlsFragLoaded', probe(49_258, 4))
    expect(hlsMock.instance!.nextLevel).toBe(-1)
  })

  it('leaves the stream alone when the duration is unknown', async () => {
    await armed(LADDER, undefined)
    hlsMock.fire('hlsFragLoaded', probe(49_258, 4))
    expect(hlsMock.instance!.nextLevel).toBe(-1)
  })

  it('leaves the stream alone when the fragment yields no measurement', async () => {
    await armed(LADDER, SHORT)
    hlsMock.fire('hlsFragLoaded', probe(0, 4))
    expect(hlsMock.instance!.nextLevel).toBe(-1)
  })

  it('drops a rung on a media error instead of capping a disabled ABR', async () => {
    // Holding a rendition turns hls.js's auto mode off, and
    // `autoLevelCapping` only constrains auto mode — so the old cap
    // would have been a silent no-op and the decode wall would repeat.
    await armed(LADDER, SHORT)
    hlsMock.fire('hlsFragLoaded', probe(49_258, 4))
    expect(hlsMock.instance!.nextLevel).toBe(2)

    hlsMock.instance!.currentLevel = 2
    hlsMock.fire('hlsError', { fatal: true, type: 'mediaError', details: 'bufferAppendError' })
    expect(hlsMock.instance!.nextLevel).toBe(1)
    expect(hlsMock.instance!.recoverMediaError).toHaveBeenCalled()

    hlsMock.fire('hlsError', { fatal: true, type: 'mediaError', details: 'bufferAppendError' })
    expect(hlsMock.instance!.nextLevel).toBe(0)
  })

  it('still caps ABR on a media error when no rendition is held', async () => {
    await armed(LADDER, { totalduration: 3600 })
    hlsMock.instance!.currentLevel = 2
    hlsMock.fire('hlsError', { fatal: true, type: 'mediaError', details: 'bufferAppendError' })
    expect(hlsMock.instance!.autoLevelCapping).toBe(1)
    expect(hlsMock.instance!.nextLevel).toBe(-1)
  })
})
