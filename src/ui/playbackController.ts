// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Playback controls: play/pause, scrubbing, step, rewind, captions, and the playback loop.
 *
 * Extracted from InteractiveSphere to isolate video playback concerns.
 */

import type { HLSService } from '../services/hlsService'
import type { AppState, Dataset } from '../types'
import { logger } from '../utils/logger'
import { proxyCaptionUrl } from '../utils/captionProxy'
import { t } from '../i18n'
import { playableStart } from '../utils/mediaReadiness'
import { reportError } from '../analytics'

// --- Playback constants ---
const LOOP_RESTART_DELAY_MS = 2000
const VIDEO_END_THRESHOLD = 0.05
const SCRUBBER_MAX = 1000
const DEFAULT_FRAME_STEP = 1 / 30

export interface PlaybackState {
  playbackUpdateId: number | null
  scrubbing: boolean
  captionTrack: TextTrack | null
  displayInterval: { intervalMs: number; showTime: boolean } | null
  loopPauseTimer: ReturnType<typeof setTimeout> | null
}

/** Create a fresh playback state with all fields at their defaults. */
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

/** Start a requestAnimationFrame loop that updates the scrubber, time label, and handles auto-looping. */
export function startPlaybackLoop(
  state: PlaybackState,
  hlsService: HLSService | null,
  videoTexture: { needsUpdate: boolean } | null,
  appState: AppState,
  updateVideoTimeLabel: (time: number) => void,
  triggerRepaint?: () => void,
  onTick?: () => void,
): void {
  stopPlaybackLoop(state)

  const loop = () => {
    // Fires every frame regardless of primary play/pause state. Used
    // by multi-viewport sync to keep sibling panels locked to the
    // primary's date; self-guards when there is nothing to correct.
    // Isolated so a transient throw (e.g. a null access during panel
    // teardown) can't abort the loop before the next rAF is scheduled —
    // that would silently freeze the scrubber, time label, and auto-loop.
    if (onTick) {
      try {
        onTick()
      } catch (e) {
        logger.warn('[App] Playback onTick failed:', e)
      }
    }

    if (hlsService) {
      const video = hlsService.getVideo()
      if (video && video.readyState >= 2) {
        if (state.scrubbing && videoTexture) {
          videoTexture.needsUpdate = true
          state.scrubbing = false
        }

        // Auto-loop: pause at end, then restart after 2 seconds
        if (!video.paused && video.currentTime >= video.duration - VIDEO_END_THRESHOLD && !state.loopPauseTimer) {
          video.pause()
          state.loopPauseTimer = setTimeout(() => {
            state.loopPauseTimer = null
            if (hlsService && appState.isPlaying) {
              // Not a literal 0: on an engine that left a hole at the
              // head of `buffered`, restarting there parks the playhead
              // where nothing can be decoded, so the loop that had been
              // playing correctly freezes on its second pass with no
              // error. See `playableStart`.
              video.currentTime = playableStart(video.buffered)
              video.play().catch(() => {})
            }
          }, LOOP_RESTART_DELAY_MS)
        }

        const scrubber = document.getElementById('scrubber') as HTMLInputElement
        if (scrubber && !scrubber.matches(':active')) {
          const fraction = video.duration > 0 ? video.currentTime / video.duration : 0
          scrubber.value = String(Math.round(fraction * SCRUBBER_MAX))
        }

        updateVideoTimeLabel(video.currentTime)

        // Force MapLibre to re-render while video is playing so the
        // globe texture updates with each new video frame.
        if (!video.paused && triggerRepaint) {
          triggerRepaint()
        }
      }
    }

    state.playbackUpdateId = requestAnimationFrame(loop)
  }

  state.playbackUpdateId = requestAnimationFrame(loop)
}

/** Cancel the running playback animation frame loop. */
export function stopPlaybackLoop(state: PlaybackState): void {
  if (state.playbackUpdateId !== null) {
    cancelAnimationFrame(state.playbackUpdateId)
    state.playbackUpdateId = null
  }
}

// --- Keyboard shortcuts ---

/** A playback action a bare key stands for (see `playbackShortcutFor`). */
export type PlaybackShortcut = 'toggle' | 'step-back' | 'step-forward' | 'start' | 'end'

const SHORTCUT_BY_CODE: Readonly<Record<string, PlaybackShortcut>> = {
  Space: 'toggle',
  ArrowLeft: 'step-back',
  ArrowRight: 'step-forward',
  Home: 'start',
  End: 'end',
}

const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'

/** What moves its caret, selection or value by the arrows, Home and End.
 *  A `role="toolbar"` is not here: the transport bar is one, moves
 *  between its buttons by Tab, and keeps the arrows for stepping. */
const ARROW_OWNERS = [
  EDITABLE,
  ...['listbox', 'menu', 'menubar', 'radiogroup', 'tablist', 'tree', 'treegrid', 'grid',
    'slider', 'spinbutton', 'scrollbar', 'combobox', 'textbox', 'searchbox'].map((role) => `[role="${role}"]`),
].join(', ')

/** What Space presses, ticks, opens or types into: every arrow owner
 *  (a focused list or grid acts on its current item), and controls. */
const SPACE_OWNERS = [
  ARROW_OWNERS,
  'button, a[href], summary',
  ...['button', 'link', 'checkbox', 'switch', 'radio', 'tab', 'option', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'treeitem', 'gridcell'].map((role) => `[role="${role}"]`),
].join(', ')

const DIALOGS = 'dialog, [role="dialog"], [role="alertdialog"]'

/** The parts of a `KeyboardEvent` the decision reads. */
export type ShortcutKeyEvent = Pick<
  KeyboardEvent,
  'code' | 'target' | 'defaultPrevented' | 'isComposing' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'
>

/**
 * The playback action a key press stands for, or `null` when the key
 * belongs to something else. Space toggles playback; the arrows step
 * a frame, Home rewinds and End fast-forwards.
 *
 * The page-wide handler once took these keys everywhere but a text
 * field and the browse panel, and cancelled their default action. So
 * Space did nothing on any focused button, link or switch (Space
 * presses a button through that default action) and toggled the
 * dataset behind it instead; arrow keys stepped the dataset from
 * inside the Help panel; and Alt+Left, the browser's Back, stepped a
 * frame. A key is left alone when:
 *   - it has a modifier, or is part of an IME composition, or a
 *     handler before this one already took it;
 *   - focus is inside a dialog, whose keys are its own;
 *   - for Space, focus is on something Space presses or types into;
 *   - for the others, focus is in a field or a widget that moves by
 *     arrow (a list, a menu, a tab list, a slider).
 */
export function playbackShortcutFor(event: ShortcutKeyEvent): PlaybackShortcut | null {
  const shortcut = SHORTCUT_BY_CODE[event.code]
  if (!shortcut) return null
  if (event.defaultPrevented || event.isComposing) return null
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null
  const target = event.target
  if (!(target instanceof Element)) return shortcut
  if (target.closest(DIALOGS)) return null
  if (target.closest(shortcut === 'toggle' ? SPACE_OWNERS : ARROW_OWNERS)) return null
  return shortcut
}

// --- Transport controls ---

/** Toggle between play and pause, updating the button icon and app state. */
export function togglePlayPause(
  hlsService: HLSService | null,
  appState: AppState,
  announce: (msg: string) => void,
): void {
  if (!hlsService) return

  if (hlsService.paused) {
    hlsService.play()?.catch(e => {
      logger.warn('[App] Play failed:', e)
    })
    appState.isPlaying = true
  } else {
    hlsService.pause()
    appState.isPlaying = false
  }
  updatePlayButton(hlsService.paused)
  announce(t(hlsService.paused ? 'playback.announce.paused' : 'playback.announce.started'))
}

/** Seek to the beginning of the video and pause playback. */
export function rewind(
  hlsService: HLSService | null,
  appState: AppState,
  state: PlaybackState,
  announce: (msg: string) => void,
): void {
  if (!hlsService) return
  // The earliest instant that actually holds a frame, which is 0 on
  // every engine that buffers from the start — see `playableStart`.
  const video = hlsService.getVideo()
  hlsService.currentTime = video ? playableStart(video.buffered) : 0
  hlsService.pause()
  appState.isPlaying = false
  updatePlayButton(true)
  announce(t('playback.announce.paused'))
  state.scrubbing = true
}

/** Seek to the end of the video and pause playback. */
export function fastForward(
  hlsService: HLSService | null,
  appState: AppState,
  state: PlaybackState,
  announce: (msg: string) => void,
): void {
  if (!hlsService) return
  const video = hlsService.getVideo()
  if (video && video.duration) {
    video.currentTime = Math.max(0, video.duration - VIDEO_END_THRESHOLD)
    hlsService.pause()
    appState.isPlaying = false
    updatePlayButton(true)
    announce(t('playback.announce.paused'))
    state.scrubbing = true
  }
}

/** Step one display interval forward or backward, pausing if currently playing. */
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
    announce(t('playback.announce.paused'))
  }

  let step: number
  const dataset = appState.currentDataset
  if (state.displayInterval && dataset?.startTime && dataset?.endTime) {
    const totalMs = new Date(dataset.endTime).getTime() - new Date(dataset.startTime).getTime()
    step = (state.displayInterval.intervalMs / totalMs) * video.duration
  } else {
    step = DEFAULT_FRAME_STEP
  }

  video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + direction * step))
  state.scrubbing = true
}

/** Handle scrubber input by seeking the video to the corresponding position. */
export function onScrub(
  value: number,
  hlsService: HLSService | null,
  state: PlaybackState,
): void {
  if (!hlsService) return
  const fraction = value / SCRUBBER_MAX
  const video = hlsService.getVideo()
  if (video && video.duration) {
    video.currentTime = fraction * video.duration
    state.scrubbing = true
  }
}

/** Update the play/pause button icon and ARIA label to reflect the current state. */
export function updatePlayButton(paused: boolean): void {
  const playBtn = document.getElementById('play-btn')
  if (playBtn) {
    playBtn.textContent = paused ? '\u25B6\uFE0E' : '\u23F8\uFE0E'
    playBtn.setAttribute('aria-label', t(paused ? 'playback.play.aria' : 'playback.pause.aria'))
  }
}

// --- Captions ---

/** Toggle closed-caption track visibility and update the CC button style. */
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

/** Fetch an SRT caption file, parse it, and attach cues to the video element. */
export async function loadCaptions(
  video: HTMLVideoElement,
  captionUrl: string,
  state: PlaybackState,
): Promise<void> {
  try {
    const fetchUrl = proxyCaptionUrl(captionUrl)

    const response = await fetch(fetchUrl)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const srt = await response.text()

    const cues = parseSRT(srt)
    if (cues.length === 0) {
      logger.warn('[App] Caption file contained no parseable cues')
      return
    }

    // Third arg is the LANGUAGE OF THE CAPTIONS themselves (BCP-47),
    // not the UI language — SOS captions are English regardless of the
    // viewer's locale, so this stays 'en'. Only the human-readable
    // label routes through t().
    const track = video.addTextTrack('captions', t('playback.captions.label'), 'en')
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

    logger.info(`[App] Loaded ${cues.length} caption cues`)
  } catch (error) {
    // Surface the failure to telemetry (Tier A) so we can measure
    // how often the Vimeo caption proxy fails — silent today, was
    // indistinguishable from "this dataset has no captions". The
    // info panel's "Captions available" badge remains visible on
    // failure so the user still knows captions exist for this row.
    // See `docs/WEB_CATALOG_FEATURES_PLAN.md` §5.2.
    logger.warn('[App] Failed to load captions:', error)
    reportError('caption', error)
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

// --- Time seeking ---

/**
 * Validate a setTime request without performing the seek. Used by
 * the chat panel to surface failures inline the moment a set-time
 * action streams in (instead of waiting for the deferred execution
 * after a load click). Same set of failure conditions as
 * {@link seekToDate}, side-effect-free — the success path doesn't
 * touch `video.currentTime` or pause playback. Reuses the same
 * translated error keys so the inline-on-stream copy and the
 * post-execution announce stay consistent.
 */
export function checkSeekToDate(
  isoDate: string,
  hlsService: HLSService | null,
  appState: AppState,
): { ok: true } | { ok: false; message: string } {
  if (!hlsService) {
    return { ok: false, message: t('playback.error.noVideoDataset') }
  }
  const video = hlsService.getVideo()
  if (!video || !video.duration) {
    return { ok: false, message: t('playback.error.videoNotReady') }
  }
  const dataset = appState.currentDataset
  if (!dataset?.startTime || !dataset?.endTime) {
    return { ok: false, message: t('playback.error.noTimeRange') }
  }
  const targetDate = new Date(isoDate)
  if (isNaN(targetDate.getTime())) {
    return { ok: false, message: t('playback.error.invalidDate') }
  }
  const start = new Date(dataset.startTime).getTime()
  const end = new Date(dataset.endTime).getTime()
  const totalMs = end - start
  if (totalMs <= 0) {
    return { ok: false, message: t('playback.error.invalidTimeRange') }
  }
  const targetMs = targetDate.getTime()
  if (targetMs < start || targetMs > end) {
    const startStr = dataset.startTime!.split('T')[0]
    const endStr = dataset.endTime!.split('T')[0]
    return {
      ok: false,
      message: t('playback.error.dateOutsideRange', { date: isoDate, start: startStr, end: endStr }),
    }
  }
  return { ok: true }
}

/**
 * Seek a video dataset to a specific date within its time range.
 * Returns a result indicating success/failure with a human-readable message.
 */
export function seekToDate(
  isoDate: string,
  hlsService: HLSService | null,
  appState: AppState,
  state: PlaybackState,
): { success: boolean; message: string } {
  if (!hlsService) {
    return { success: false, message: t('playback.error.noVideoDataset') }
  }

  const video = hlsService.getVideo()
  if (!video || !video.duration) {
    return { success: false, message: t('playback.error.videoNotReady') }
  }

  const dataset = appState.currentDataset
  if (!dataset?.startTime || !dataset?.endTime) {
    return { success: false, message: t('playback.error.noTimeRange') }
  }

  const targetDate = new Date(isoDate)
  if (isNaN(targetDate.getTime())) {
    return { success: false, message: t('playback.error.invalidDate') }
  }

  const start = new Date(dataset.startTime).getTime()
  const end = new Date(dataset.endTime).getTime()
  const totalMs = end - start
  if (totalMs <= 0) {
    return { success: false, message: t('playback.error.invalidTimeRange') }
  }

  // Check if date falls outside the dataset's time range
  const targetMs = targetDate.getTime()
  if (targetMs < start || targetMs > end) {
    const startStr = dataset.startTime!.split('T')[0]
    const endStr = dataset.endTime!.split('T')[0]
    return {
      success: false,
      message: t('playback.error.dateOutsideRange', { date: isoDate, start: startStr, end: endStr }),
    }
  }

  const fraction = (targetMs - start) / totalMs

  video.currentTime = fraction * video.duration
  state.scrubbing = true

  // Pause if playing so user can inspect the moment
  if (!video.paused) {
    hlsService.pause()
    appState.isPlaying = false
    updatePlayButton(true)
  }

  return { success: true, message: t('playback.seekingTo', { date: isoDate }) }
}

// --- Info panel positioning ---

/**
 * Observe the info panel and shift #playback-controls up as it expands.
 * Only applies on portrait mobile (≤600px width).
 */
export function initPlaybackPositioning(): void {
  const infoPanel = document.getElementById('info-panel')
  if (!infoPanel || typeof ResizeObserver === 'undefined') return

  const update = () => {
    const controls = document.getElementById('playback-controls')
    if (!controls) return
    const isPortraitMobile = window.innerWidth <= 600
      && window.matchMedia('(orientation: portrait)').matches
    if (infoPanel.classList.contains('expanded') && isPortraitMobile) {
      const h = infoPanel.getBoundingClientRect().height
      controls.style.bottom = `${h + 12}px`
    } else {
      controls.style.bottom = '0.75rem'
    }
  }

  new ResizeObserver(update).observe(infoPanel)
}

// --- Playback state reset ---

/** Reset playback state, clear the loop timer, hide captions, and reset the CC button. */
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
