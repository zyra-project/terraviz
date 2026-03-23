/**
 * Playback controls: play/pause, scrubbing, step, rewind, captions, and the playback loop.
 *
 * Extracted from InteractiveSphere to isolate video playback concerns.
 */

import type { HLSService } from '../services/hlsService'
import type { AppState, Dataset } from '../types'

export interface PlaybackState {
  playbackUpdateId: number | null
  scrubbing: boolean
  captionTrack: TextTrack | null
  displayInterval: { intervalMs: number; showTime: boolean } | null
  loopPauseTimer: ReturnType<typeof setTimeout> | null
}

export function createPlaybackState(): PlaybackState {
  return {
    playbackUpdateId: null,
    scrubbing: false,
    captionTrack: null,
    displayInterval: null,
    loopPauseTimer: null,
  }
}

// --- Playback loop ---

export function startPlaybackLoop(
  state: PlaybackState,
  hlsService: HLSService | null,
  videoTexture: { needsUpdate: boolean } | null,
  appState: AppState,
  updateVideoTimeLabel: (time: number) => void,
): void {
  stopPlaybackLoop(state)

  const loop = () => {
    if (hlsService) {
      const video = hlsService.getVideo()
      if (video && video.readyState >= 2) {
        if (state.scrubbing && videoTexture) {
          videoTexture.needsUpdate = true
          state.scrubbing = false
        }

        // Auto-loop: pause at end, then restart after 2 seconds
        if (!video.paused && video.currentTime >= video.duration - 0.05 && !state.loopPauseTimer) {
          video.pause()
          state.loopPauseTimer = setTimeout(() => {
            state.loopPauseTimer = null
            if (hlsService && appState.isPlaying) {
              video.currentTime = 0
              video.play().catch(() => {})
            }
          }, 2000)
        }

        const scrubber = document.getElementById('scrubber') as HTMLInputElement
        if (scrubber && !scrubber.matches(':active')) {
          const fraction = video.duration > 0 ? video.currentTime / video.duration : 0
          scrubber.value = String(Math.round(fraction * 1000))
        }

        updateVideoTimeLabel(video.currentTime)
      }
    }

    state.playbackUpdateId = requestAnimationFrame(loop)
  }

  state.playbackUpdateId = requestAnimationFrame(loop)
}

export function stopPlaybackLoop(state: PlaybackState): void {
  if (state.playbackUpdateId !== null) {
    cancelAnimationFrame(state.playbackUpdateId)
    state.playbackUpdateId = null
  }
}

// --- Transport controls ---

export function togglePlayPause(
  hlsService: HLSService | null,
  appState: AppState,
  announce: (msg: string) => void,
): void {
  if (!hlsService) return

  if (hlsService.paused) {
    hlsService.play()?.catch(e => {
      console.warn('[App] Play failed:', e)
    })
    appState.isPlaying = true
  } else {
    hlsService.pause()
    appState.isPlaying = false
  }
  updatePlayButton(hlsService.paused)
  announce(hlsService.paused ? 'Playback paused' : 'Playback started')
}

export function rewind(
  hlsService: HLSService | null,
  appState: AppState,
  state: PlaybackState,
  announce: (msg: string) => void,
): void {
  if (!hlsService) return
  hlsService.currentTime = 0
  hlsService.pause()
  appState.isPlaying = false
  updatePlayButton(true)
  announce('Playback paused')
  state.scrubbing = true
}

export function fastForward(
  hlsService: HLSService | null,
  appState: AppState,
  state: PlaybackState,
  announce: (msg: string) => void,
): void {
  if (!hlsService) return
  const video = hlsService.getVideo()
  if (video && video.duration) {
    video.currentTime = Math.max(0, video.duration - 0.05)
    hlsService.pause()
    appState.isPlaying = false
    updatePlayButton(true)
    announce('Playback paused')
    state.scrubbing = true
  }
}

export function stepFrame(
  direction: 1 | -1,
  hlsService: HLSService | null,
  appState: AppState,
  state: PlaybackState,
  announce: (msg: string) => void,
): void {
  if (!hlsService) return
  const video = hlsService.getVideo()
  if (!video || !video.duration) return

  if (!video.paused) {
    hlsService.pause()
    appState.isPlaying = false
    updatePlayButton(true)
    announce('Playback paused')
  }

  let step: number
  const dataset = appState.currentDataset
  if (state.displayInterval && dataset?.startTime && dataset?.endTime) {
    const totalMs = new Date(dataset.endTime).getTime() - new Date(dataset.startTime).getTime()
    step = (state.displayInterval.intervalMs / totalMs) * video.duration
  } else {
    step = 1 / 30
  }

  video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + direction * step))
  state.scrubbing = true
}

export function onScrub(
  value: number,
  hlsService: HLSService | null,
  state: PlaybackState,
): void {
  if (!hlsService) return
  const fraction = value / 1000
  const video = hlsService.getVideo()
  if (video && video.duration) {
    video.currentTime = fraction * video.duration
    state.scrubbing = true
  }
}

export function updatePlayButton(paused: boolean): void {
  const playBtn = document.getElementById('play-btn')
  if (playBtn) {
    playBtn.textContent = paused ? '\u25B6\uFE0E' : '\u23F8\uFE0E'
    playBtn.setAttribute('aria-label', paused ? 'Play' : 'Pause')
  }
}

// --- Captions ---

export function toggleCaptions(state: PlaybackState): void {
  if (!state.captionTrack) return
  const ccBtn = document.getElementById('cc-btn')
  const overlay = document.getElementById('caption-overlay')
  const turning = state.captionTrack.mode !== 'showing'
  state.captionTrack.mode = turning ? 'showing' : 'hidden'
  if (ccBtn) {
    ccBtn.style.color = turning ? '#4da6ff' : ''
    ccBtn.style.borderColor = turning ? '#4da6ff' : ''
  }
  if (!turning && overlay) {
    overlay.textContent = ''
    overlay.style.display = 'none'
  }
}

export async function loadCaptions(
  video: HTMLVideoElement,
  captionUrl: string,
  state: PlaybackState,
): Promise<void> {
  try {
    const fetchUrl = captionUrl.includes('sos.noaa.gov')
      ? `https://video-proxy.zyra-project.org/captions?url=${encodeURIComponent(captionUrl)}`
      : captionUrl

    const response = await fetch(fetchUrl)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const srt = await response.text()

    const cues = parseSRT(srt)
    if (cues.length === 0) {
      console.warn('[App] Caption file contained no parseable cues')
      return
    }

    const track = video.addTextTrack('captions', 'Closed Captions', 'en')
    track.mode = 'hidden'
    for (const cue of cues) {
      track.addCue(new VTTCue(cue.start, cue.end, cue.text))
    }

    track.addEventListener('cuechange', () => {
      const overlay = document.getElementById('caption-overlay')
      if (!overlay) return
      const activeCues = track.activeCues
      if (!activeCues || activeCues.length === 0 || track.mode !== 'showing') {
        overlay.textContent = ''
        overlay.style.display = 'none'
      } else {
        overlay.textContent = Array.from(activeCues).map(c => (c as VTTCue).text).join('\n')
        overlay.style.display = 'block'
      }
    })

    state.captionTrack = track

    const ccBtn = document.getElementById('cc-btn')
    if (ccBtn) ccBtn.classList.remove('hidden')

    console.log(`[App] Loaded ${cues.length} caption cues`)
  } catch (error) {
    console.warn('[App] Failed to load captions:', error)
  }
}

function parseSRT(srt: string): Array<{ start: number; end: number; text: string }> {
  const cues: Array<{ start: number; end: number; text: string }> = []
  const blocks = srt.trim().split(/\r?\n\s*\r?\n/)
  for (const block of blocks) {
    const lines = block.trim().split(/\r?\n/)
    let timingIdx = -1
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('-->')) { timingIdx = i; break }
    }
    if (timingIdx < 0) continue
    const parts = lines[timingIdx].split('-->')
    if (parts.length !== 2) continue
    const start = parseSRTTime(parts[0].trim())
    const end = parseSRTTime(parts[1].trim())
    const text = lines.slice(timingIdx + 1).join('\n').trim()
    if (text) cues.push({ start, end, text })
  }
  return cues
}

function parseSRTTime(t: string): number {
  const m = t.match(/(\d+):(\d+):(\d+)[,.](\d+)/)
  if (!m) return 0
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4]) / 1000
}

// --- Playback state reset ---

export function resetPlaybackState(state: PlaybackState): void {
  state.displayInterval = null
  if (state.loopPauseTimer) {
    clearTimeout(state.loopPauseTimer)
    state.loopPauseTimer = null
  }
  state.captionTrack = null
  const ccBtn = document.getElementById('cc-btn')
  if (ccBtn) {
    ccBtn.classList.add('hidden')
    ccBtn.style.color = ''
    ccBtn.style.borderColor = ''
  }
  const overlay = document.getElementById('caption-overlay')
  if (overlay) {
    overlay.textContent = ''
    overlay.style.display = 'none'
  }
}
