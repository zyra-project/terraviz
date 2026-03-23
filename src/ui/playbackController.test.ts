import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createPlaybackState,
  startPlaybackLoop,
  stopPlaybackLoop,
  togglePlayPause,
  rewind,
  fastForward,
  stepFrame,
  onScrub,
  updatePlayButton,
  toggleCaptions,
  resetPlaybackState,
  loadCaptions,
  type PlaybackState,
} from './playbackController'
import type { AppState } from '../types'

// Stub requestAnimationFrame / cancelAnimationFrame
let rafCallbacks: FrameRequestCallback[] = []
let rafId = 0
vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback) => {
  rafCallbacks.push(cb)
  return ++rafId
}))
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

function makeMockHls(overrides: Record<string, any> = {}) {
  return {
    paused: true,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    get currentTime() { return overrides.currentTime ?? 0 },
    set currentTime(v: number) { overrides.currentTime = v },
    get duration() { return overrides.duration ?? 60 },
    getVideo: vi.fn().mockReturnValue({
      paused: overrides.paused ?? true,
      currentTime: overrides.currentTime ?? 0,
      duration: overrides.duration ?? 60,
      readyState: 4,
    }),
    video: {
      muted: false,
    },
    ...overrides,
  } as any
}

// ---------------------------------------------------------------------------
// createPlaybackState
// ---------------------------------------------------------------------------
describe('createPlaybackState', () => {
  it('returns initial state with all null/false values', () => {
    const state = createPlaybackState()
    expect(state.playbackUpdateId).toBeNull()
    expect(state.scrubbing).toBe(false)
    expect(state.captionTrack).toBeNull()
    expect(state.displayInterval).toBeNull()
    expect(state.loopPauseTimer).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// startPlaybackLoop / stopPlaybackLoop
// ---------------------------------------------------------------------------
describe('startPlaybackLoop / stopPlaybackLoop', () => {
  let state: PlaybackState

  beforeEach(() => {
    state = createPlaybackState()
    rafCallbacks = []
    rafId = 0
    vi.clearAllMocks()
  })

  it('sets playbackUpdateId when started', () => {
    const hls = makeMockHls()
    startPlaybackLoop(state, hls, null, makeAppState(), vi.fn())
    expect(state.playbackUpdateId).toBeTruthy()
    expect(requestAnimationFrame).toHaveBeenCalled()
  })

  it('clears playbackUpdateId when stopped', () => {
    state.playbackUpdateId = 42
    stopPlaybackLoop(state)
    expect(state.playbackUpdateId).toBeNull()
    expect(cancelAnimationFrame).toHaveBeenCalledWith(42)
  })

  it('stopPlaybackLoop is safe to call when already stopped', () => {
    state.playbackUpdateId = null
    expect(() => stopPlaybackLoop(state)).not.toThrow()
    expect(cancelAnimationFrame).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// togglePlayPause
// ---------------------------------------------------------------------------
describe('togglePlayPause', () => {
  beforeEach(() => {
    document.body.innerHTML = '<button id="play-btn"></button>'
  })

  it('plays when currently paused', () => {
    const hls = makeMockHls({ paused: true })
    const appState = makeAppState()
    const announce = vi.fn()

    togglePlayPause(hls, appState, announce)

    expect(hls.play).toHaveBeenCalled()
    expect(appState.isPlaying).toBe(true)
  })

  it('pauses when currently playing', () => {
    const hls = makeMockHls({ paused: false })
    const appState = makeAppState({ isPlaying: true })
    const announce = vi.fn()

    togglePlayPause(hls, appState, announce)

    expect(hls.pause).toHaveBeenCalled()
    expect(appState.isPlaying).toBe(false)
  })

  it('does nothing when hlsService is null', () => {
    const appState = makeAppState()
    expect(() => togglePlayPause(null, appState, vi.fn())).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// rewind
// ---------------------------------------------------------------------------
describe('rewind', () => {
  it('sets currentTime to 0 and pauses', () => {
    const hls = makeMockHls()
    const appState = makeAppState({ isPlaying: true })
    const state = createPlaybackState()

    rewind(hls, appState, state, vi.fn())

    expect(hls.currentTime).toBe(0)
    expect(hls.pause).toHaveBeenCalled()
    expect(appState.isPlaying).toBe(false)
    expect(state.scrubbing).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// fastForward
// ---------------------------------------------------------------------------
describe('fastForward', () => {
  it('seeks to end of video and pauses', () => {
    const videoState = { currentTime: 0, duration: 60, paused: false }
    const hls = makeMockHls()
    hls.getVideo = vi.fn().mockReturnValue({
      ...videoState,
      get currentTime() { return videoState.currentTime },
      set currentTime(v: number) { videoState.currentTime = v },
      duration: 60,
      readyState: 4,
    })
    const appState = makeAppState({ isPlaying: true })
    const state = createPlaybackState()

    fastForward(hls, appState, state, vi.fn())

    expect(videoState.currentTime).toBeCloseTo(59.95, 1)
    expect(appState.isPlaying).toBe(false)
    expect(state.scrubbing).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// stepFrame
// ---------------------------------------------------------------------------
describe('stepFrame', () => {
  it('steps forward by 1/30s when no display interval', () => {
    const videoState = { currentTime: 1.0 }
    const hls = makeMockHls()
    hls.getVideo = vi.fn().mockReturnValue({
      get currentTime() { return videoState.currentTime },
      set currentTime(v: number) { videoState.currentTime = v },
      duration: 60,
      paused: true,
      readyState: 4,
    })
    const appState = makeAppState()
    const state = createPlaybackState()

    stepFrame(1, hls, appState, state, vi.fn())

    expect(videoState.currentTime).toBeCloseTo(1.0 + 1 / 30, 4)
    expect(state.scrubbing).toBe(true)
  })

  it('steps backward', () => {
    const videoState = { currentTime: 1.0 }
    const hls = makeMockHls()
    hls.getVideo = vi.fn().mockReturnValue({
      get currentTime() { return videoState.currentTime },
      set currentTime(v: number) { videoState.currentTime = v },
      duration: 60,
      paused: true,
      readyState: 4,
    })
    const appState = makeAppState()
    const state = createPlaybackState()

    stepFrame(-1, hls, appState, state, vi.fn())

    expect(videoState.currentTime).toBeCloseTo(1.0 - 1 / 30, 4)
  })

  it('uses display interval step size when available', () => {
    const videoState = { currentTime: 10.0 }
    const hls = makeMockHls()
    hls.getVideo = vi.fn().mockReturnValue({
      get currentTime() { return videoState.currentTime },
      set currentTime(v: number) { videoState.currentTime = v },
      duration: 120,
      paused: true,
      readyState: 4,
    })

    const appState = makeAppState({
      currentDataset: {
        id: 'test', title: 'Test', format: 'video/mp4', dataLink: '',
        startTime: '2020-01-01T00:00:00Z',
        endTime: '2020-01-02T00:00:00Z', // 86400000 ms span
      }
    })

    const state = createPlaybackState()
    state.displayInterval = { intervalMs: 3600000, showTime: true } // 1 hour

    stepFrame(1, hls, appState, state, vi.fn())

    // Expected step: (3600000 / 86400000) * 120 = 5.0 seconds
    expect(videoState.currentTime).toBeCloseTo(15.0, 2)
  })

  it('clamps at 0 when stepping backward past start', () => {
    const videoState = { currentTime: 0.01 }
    const hls = makeMockHls()
    hls.getVideo = vi.fn().mockReturnValue({
      get currentTime() { return videoState.currentTime },
      set currentTime(v: number) { videoState.currentTime = v },
      duration: 60,
      paused: true,
      readyState: 4,
    })
    const appState = makeAppState()
    const state = createPlaybackState()

    stepFrame(-1, hls, appState, state, vi.fn())
    expect(videoState.currentTime).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// onScrub
// ---------------------------------------------------------------------------
describe('onScrub', () => {
  it('sets video currentTime to fraction of duration', () => {
    const videoState = { currentTime: 0 }
    const hls = makeMockHls()
    hls.getVideo = vi.fn().mockReturnValue({
      get currentTime() { return videoState.currentTime },
      set currentTime(v: number) { videoState.currentTime = v },
      duration: 100,
    })
    const state = createPlaybackState()

    onScrub(500, hls, state)  // 500/1000 = 50%

    expect(videoState.currentTime).toBe(50)
    expect(state.scrubbing).toBe(true)
  })

  it('does nothing when hlsService is null', () => {
    const state = createPlaybackState()
    expect(() => onScrub(500, null, state)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// updatePlayButton
// ---------------------------------------------------------------------------
describe('updatePlayButton', () => {
  beforeEach(() => {
    document.body.innerHTML = '<button id="play-btn"></button>'
  })

  it('shows play icon when paused', () => {
    updatePlayButton(true)
    const btn = document.getElementById('play-btn')!
    expect(btn.textContent).toBe('\u25B6\uFE0E')
    expect(btn.getAttribute('aria-label')).toBe('Play')
  })

  it('shows pause icon when playing', () => {
    updatePlayButton(false)
    const btn = document.getElementById('play-btn')!
    expect(btn.textContent).toBe('\u23F8\uFE0E')
    expect(btn.getAttribute('aria-label')).toBe('Pause')
  })
})

// ---------------------------------------------------------------------------
// toggleCaptions
// ---------------------------------------------------------------------------
describe('toggleCaptions', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button id="cc-btn"></button>
      <div id="caption-overlay"></div>
    `
  })

  it('does nothing when no caption track', () => {
    const state = createPlaybackState()
    expect(() => toggleCaptions(state)).not.toThrow()
  })

  it('enables captions when currently hidden', () => {
    const state = createPlaybackState()
    state.captionTrack = { mode: 'hidden' } as TextTrack

    toggleCaptions(state)

    expect(state.captionTrack.mode).toBe('showing')
    expect(document.getElementById('cc-btn')!.style.color).toBe('#4da6ff')
  })

  it('disables captions when currently showing', () => {
    const state = createPlaybackState()
    state.captionTrack = { mode: 'showing' } as TextTrack

    toggleCaptions(state)

    expect(state.captionTrack.mode).toBe('hidden')
    const overlay = document.getElementById('caption-overlay')!
    expect(overlay.style.display).toBe('none')
  })
})

// ---------------------------------------------------------------------------
// resetPlaybackState
// ---------------------------------------------------------------------------
describe('resetPlaybackState', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button id="cc-btn" style="color: #4da6ff; border-color: #4da6ff;"></button>
      <div id="caption-overlay" style="display: block;">Some caption</div>
    `
  })

  it('resets state and clears UI elements', () => {
    const state = createPlaybackState()
    state.displayInterval = { intervalMs: 1000, showTime: true }
    state.captionTrack = {} as TextTrack
    state.loopPauseTimer = setTimeout(() => {}, 99999)

    resetPlaybackState(state)

    expect(state.displayInterval).toBeNull()
    expect(state.captionTrack).toBeNull()
    expect(state.loopPauseTimer).toBeNull()

    const ccBtn = document.getElementById('cc-btn')!
    expect(ccBtn.classList.contains('hidden')).toBe(true)
    expect(ccBtn.style.color).toBe('')

    const overlay = document.getElementById('caption-overlay')!
    expect(overlay.textContent).toBe('')
    expect(overlay.style.display).toBe('none')
  })
})

// ---------------------------------------------------------------------------
// loadCaptions — SRT parsing via integration
// ---------------------------------------------------------------------------
describe('loadCaptions', () => {
  it('parses SRT and adds text track cues', async () => {
    const srtContent = `1
00:00:01,000 --> 00:00:04,000
Hello world

2
00:00:05,500 --> 00:00:08,000
Second cue`

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(srtContent),
    }))

    const state = createPlaybackState()
    const video = document.createElement('video')
    // happy-dom may not fully implement addTextTrack, so mock it
    const mockTrack = {
      mode: 'hidden',
      addCue: vi.fn(),
      addEventListener: vi.fn(),
    }
    video.addTextTrack = vi.fn().mockReturnValue(mockTrack) as any

    document.body.innerHTML = '<button id="cc-btn" class="hidden"></button>'

    await loadCaptions(video, 'https://example.com/captions.srt', state)

    expect(video.addTextTrack).toHaveBeenCalledWith('captions', 'Closed Captions', 'en')
    expect(mockTrack.addCue).toHaveBeenCalledTimes(2)
    expect(state.captionTrack).toBe(mockTrack)
    expect(document.getElementById('cc-btn')!.classList.contains('hidden')).toBe(false)
  })

  it('routes sos.noaa.gov URLs through proxy', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(''),
    }))

    const state = createPlaybackState()
    const video = document.createElement('video')
    video.addTextTrack = vi.fn().mockReturnValue({ mode: 'hidden', addCue: vi.fn(), addEventListener: vi.fn() }) as any

    await loadCaptions(video, 'https://sos.noaa.gov/captions/test.srt', state)

    const fetchCall = (fetch as any).mock.calls[0][0] as string
    expect(fetchCall).toContain('video-proxy.zyra-project.org/captions')
    expect(fetchCall).toContain(encodeURIComponent('https://sos.noaa.gov/captions/test.srt'))
  })

  it('handles fetch failure gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')))
    const state = createPlaybackState()
    const video = document.createElement('video')

    // Should not throw
    await loadCaptions(video, 'https://example.com/fail.srt', state)
    expect(state.captionTrack).toBeNull()
  })
})
