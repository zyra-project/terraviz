import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HLSService } from './hlsService'

// ---------------------------------------------------------------------------
// Mock hls.js — we test HLSService logic, not the HLS library itself
// ---------------------------------------------------------------------------
vi.mock('hls.js', () => {
  const MockHls = Object.assign(
    vi.fn().mockImplementation(() => ({
      loadSource: vi.fn(),
      attachMedia: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(),
      levels: [],
      startLoad: vi.fn(),
      recoverMediaError: vi.fn(),
    })),
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
