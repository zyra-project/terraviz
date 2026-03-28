import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createPlaybackState,
  seekToDate,
} from './playbackController'
import type { AppState } from '../types'

// Stub requestAnimationFrame / cancelAnimationFrame
vi.stubGlobal('requestAnimationFrame', vi.fn())
vi.stubGlobal('cancelAnimationFrame', vi.fn())

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeAppState(overrides: Partial<AppState> = {}): AppState {
  return {
    datasets: [],
    currentDataset: null,
    isLoading: false,
    error: null,
    timeLabel: '--',
    isPlaying: false,
    currentFrame: 0,
    totalFrames: 0,
    ...overrides,
  }
}

function makeMockHls(videoOverrides: Record<string, any> = {}) {
  const videoState = {
    currentTime: 0,
    duration: 100,
    paused: false,
    readyState: 4,
    ...videoOverrides,
  }
  return {
    paused: videoState.paused,
    pause: vi.fn(() => { videoState.paused = true }),
    play: vi.fn().mockResolvedValue(undefined),
    getVideo: vi.fn().mockReturnValue({
      get currentTime() { return videoState.currentTime },
      set currentTime(v: number) { videoState.currentTime = v },
      get duration() { return videoState.duration },
      get paused() { return videoState.paused },
      set paused(v: boolean) { videoState.paused = v },
      readyState: videoState.readyState,
    }),
    _videoState: videoState,
  } as any
}

// ---------------------------------------------------------------------------
// seekToDate
// ---------------------------------------------------------------------------
describe('seekToDate', () => {
  beforeEach(() => {
    document.body.innerHTML = '<button id="play-btn"></button>'
  })

  it('seeks to mid-range date correctly', () => {
    const hls = makeMockHls({ duration: 100 })
    const appState = makeAppState({
      currentDataset: {
        id: 'test', title: 'Test', format: 'video/mp4', dataLink: '',
        startTime: '2020-01-01T00:00:00Z',
        endTime: '2020-12-31T00:00:00Z',
      },
    })
    const state = createPlaybackState()

    // July 1 is roughly halfway through the year
    const result = seekToDate('2020-07-01T00:00:00Z', hls, appState, state)

    expect(result.success).toBe(true)
    expect(state.scrubbing).toBe(true)
    // Check video was seeked to approximately 50% of duration
    const video = hls.getVideo()
    const fraction = video.currentTime / video.duration
    expect(fraction).toBeGreaterThan(0.45)
    expect(fraction).toBeLessThan(0.55)
  })

  it('rejects date before startTime', () => {
    const hls = makeMockHls({ duration: 100 })
    const appState = makeAppState({
      currentDataset: {
        id: 'test', title: 'Test', format: 'video/mp4', dataLink: '',
        startTime: '2020-01-01T00:00:00Z',
        endTime: '2020-12-31T00:00:00Z',
      },
    })
    const state = createPlaybackState()

    const result = seekToDate('2019-01-01T00:00:00Z', hls, appState, state)

    expect(result.success).toBe(false)
    expect(result.message).toContain('outside')
  })

  it('rejects date after endTime', () => {
    const hls = makeMockHls({ duration: 100 })
    const appState = makeAppState({
      currentDataset: {
        id: 'test', title: 'Test', format: 'video/mp4', dataLink: '',
        startTime: '2020-01-01T00:00:00Z',
        endTime: '2020-12-31T00:00:00Z',
      },
    })
    const state = createPlaybackState()

    const result = seekToDate('2025-01-01T00:00:00Z', hls, appState, state)

    expect(result.success).toBe(false)
    expect(result.message).toContain('outside')
  })

  it('returns failure for invalid date', () => {
    const hls = makeMockHls({ duration: 100 })
    const appState = makeAppState({
      currentDataset: {
        id: 'test', title: 'Test', format: 'video/mp4', dataLink: '',
        startTime: '2020-01-01T00:00:00Z',
        endTime: '2020-12-31T00:00:00Z',
      },
    })
    const state = createPlaybackState()

    const result = seekToDate('not-a-date', hls, appState, state)

    expect(result.success).toBe(false)
    expect(result.message).toContain('Invalid')
  })

  it('returns failure when no time range', () => {
    const hls = makeMockHls({ duration: 100 })
    const appState = makeAppState({
      currentDataset: {
        id: 'test', title: 'Test', format: 'video/mp4', dataLink: '',
      },
    })
    const state = createPlaybackState()

    const result = seekToDate('2020-07-01', hls, appState, state)

    expect(result.success).toBe(false)
    expect(result.message).toContain('no time range')
  })

  it('returns failure when no video loaded', () => {
    const appState = makeAppState()
    const state = createPlaybackState()

    const result = seekToDate('2020-07-01', null, appState, state)

    expect(result.success).toBe(false)
    expect(result.message).toContain('No video')
  })

  it('pauses playback when seeking', () => {
    const hls = makeMockHls({ duration: 100, paused: false })
    const appState = makeAppState({
      isPlaying: true,
      currentDataset: {
        id: 'test', title: 'Test', format: 'video/mp4', dataLink: '',
        startTime: '2020-01-01T00:00:00Z',
        endTime: '2020-12-31T00:00:00Z',
      },
    })
    const state = createPlaybackState()

    seekToDate('2020-07-01', hls, appState, state)

    expect(hls.pause).toHaveBeenCalled()
    expect(appState.isPlaying).toBe(false)
  })
})
