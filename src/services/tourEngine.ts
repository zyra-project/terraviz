/**
 * Tour Engine — executes a sequence of tour tasks against the globe.
 *
 * Design:
 * - Each task is async; the engine awaits it before moving to the next.
 * - `pauseForInput` resolves only when the user presses play / spacebar.
 * - The engine exposes play/pause/next/prev/stop controls.
 * - It communicates with the rest of the app through {@link TourCallbacks}.
 */

import { logger } from '../utils/logger'
import { getCloudTextureUrl } from '../utils/deviceCapability'
import { getSunPosition } from '../utils/time'
import type {
  TourFile, TourTaskDef, TourState, TourCallbacks,
  FlyToTaskParams, ShowRectTaskParams, DatasetAnimationTaskParams,
  TiltRotateCameraTaskParams, QuestionTaskParams,
  PlayAudioTaskParams, PlayVideoTaskParams, ShowImageTaskParams,
  ShowPopupHtmlTaskParams, AddPlacemarkTaskParams,
} from '../types'
import { syncMapControlState } from '../ui/mapControlsUI'
import {
  showTourTextBox, hideTourTextBox, hideAllTourTextBoxes, updateTourProgress,
  showTourImage, hideTourImage, hideAllTourImages,
  showTourVideo, hideTourVideo, hideAllTourVideos,
  showTourPopup, hideTourPopup, hideAllTourPopups,
  showTourQuestion, hideAllTourQuestions,
  showTourControls as showControls, hideTourControls as hideControls,
  updateTourPlayState,
  showTourLegend, hideTourLegend,
} from '../ui/tourUI'

// Miles → kilometres
const MI_TO_KM = 1.60934

// SOS altitude values are camera-distance parameters for the Unity renderer,
// not true orbital altitudes. They need to be scaled down to produce
// equivalent MapLibre zoom levels. Empirically, 0.2 maps SOS altitudes
// to views that match the legacy app (e.g., 4200 mi → zoom ~3.2 continent view).
const SOS_ALTITUDE_SCALE = 0.2

/**
 * Determine which task key is present in a TourTaskDef and return [key, value].
 */
function identifyTask(def: TourTaskDef): [string, unknown] {
  const keys = Object.keys(def)
  if (keys.length !== 1) {
    logger.warn('[Tour] Invalid task definition: expected exactly one key', def)
    return ['', undefined]
  }
  const key = keys[0]
  return [key, (def as Record<string, unknown>)[key]]
}

export class TourEngine {
  private tasks: TourTaskDef[]
  private index = 0
  private _state: TourState = 'stopped'
  private callbacks: TourCallbacks

  // Used to resolve `pauseForInput` / `pauseSeconds` from outside
  private resumeResolver: (() => void) | null = null
  private pauseTimer: ReturnType<typeof setTimeout> | null = null
  private pauseTimerResolver: (() => void) | null = null

  // When next/prev changes the index during a task, this flag tells the
  // loop to skip its normal index++ at the bottom of the iteration.
  private indexOverridden = false


  // Active audio element for playAudio/stopAudio
  private activeAudio: HTMLAudioElement | null = null

  // Active placemarks keyed by ID for cleanup
  private activePlacemarks = new Map<string, unknown>()

  constructor(tourFile: TourFile, callbacks: TourCallbacks) {
    this.tasks = tourFile.tourTasks
    this.callbacks = callbacks
  }

  get state(): TourState { return this._state }
  get currentIndex(): number { return this.index }
  get totalSteps(): number { return this.tasks.length }

  // ── Playback controls ──────────────────────────────────────────────

  /** Start or resume the tour from the current index. */
  async play(): Promise<void> {
    if (this._state === 'paused' && this.resumeResolver) {
      // Resume from a pauseForInput / pauseSeconds
      this._state = 'playing'
      updateTourPlayState(true)
      this.resumeResolver()
      this.resumeResolver = null
      return
    }

    if (this._state === 'playing') return

    this._state = 'playing'
    updateTourPlayState(true)
    await this.runLoop()
  }

  /** Pause the tour. If currently executing a flyTo or timed pause, it will
   *  finish the current task but stop before the next one. */
  pause(): void {
    if (this._state !== 'playing') return
    this._state = 'paused'
    updateTourPlayState(false)
  }

  /** Cancel any active pauseSeconds timer and resolve its promise. */
  private cancelPauseTimer(): void {
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer)
      this.pauseTimer = null
    }
    if (this.pauseTimerResolver) {
      this.pauseTimerResolver()
      this.pauseTimerResolver = null
    }
  }

  /** Check if a task key is a pause-type task. */
  private static isPauseTask(key: string): boolean {
    return key === 'pauseForInput' || key === 'pauseSeconds' || key === 'pauseSec'
  }

  /** Advance past the current pause and resume playing from the next task. */
  next(): void {
    if (this.index >= this.tasks.length - 1) return

    this.cancelPauseTimer()

    this.index++
    this.indexOverridden = true
    updateTourProgress(this.index, this.tasks.length)

    if (this.resumeResolver) {
      this._state = 'playing'
      updateTourPlayState(true)
      this.resumeResolver()
      this.resumeResolver = null
    } else if (this._state === 'stopped') {
      // Stopped — user can call play() to start from the new index
    }
  }

  /**
   * Go back to the previous "segment" — find the pause point before
   * the current one and replay from the segment start (the pause before
   * that, or the beginning of the tour).
   */
  prev(): void {
    if (this.index <= 0) return

    this.cancelPauseTimer()

    // Find the previous pause point before our current position
    let prevPause = -1
    for (let i = this.index - 1; i >= 0; i--) {
      const [key] = identifyTask(this.tasks[i])
      if (TourEngine.isPauseTask(key)) {
        prevPause = i
        break
      }
    }

    // Find the segment start: the pause before prevPause, or index 0
    let segmentStart = 0
    if (prevPause > 0) {
      for (let i = prevPause - 1; i >= 0; i--) {
        const [key] = identifyTask(this.tasks[i])
        if (TourEngine.isPauseTask(key)) {
          segmentStart = i + 1
          break
        }
      }
    }

    // Clean up existing overlays before replaying the segment
    hideAllTourTextBoxes()
    hideAllTourImages()
    hideAllTourVideos()
    hideAllTourPopups()
    hideAllTourQuestions()

    this.index = segmentStart
    this.indexOverridden = true
    updateTourProgress(this.index, this.tasks.length)

    if (this.resumeResolver) {
      this._state = 'playing'
      updateTourPlayState(true)
      this.resumeResolver()
      this.resumeResolver = null
    } else if (this._state === 'stopped') {
      // Stopped — user can call play() to start from the new index
    }
  }

  /** Stop and reset the tour. Does NOT call onTourEnd — caller handles cleanup. */
  stop(): void {
    this._state = 'stopped'
    this.cancelPauseTimer()
    if (this.resumeResolver) {
      this.resumeResolver()
      this.resumeResolver = null
    }
    this.cleanup()
  }

  /** Clean up all tour-created overlays and media. */
  private cleanup(): void {
    hideAllTourTextBoxes()
    hideAllTourImages()
    hideAllTourVideos()
    hideAllTourPopups()
    hideAllTourQuestions()
    hideTourLegend()
    this.stopActiveAudio()
    this.clearPlacemarks()
  }

  /** Read current state without TS narrowing (state can change during awaits). */
  private isStopped(): boolean { return this._state === 'stopped' }

  // ── Main execution loop ────────────────────────────────────────────

  private async runLoop(): Promise<void> {
    while (this.index < this.tasks.length) {
      if (this.isStopped()) return
      if (this._state === 'paused') {
        // Wait for resume (next/prev/play will resolve this)
        await new Promise<void>(resolve => { this.resumeResolver = resolve })
        if (this.isStopped()) return
        // next()/prev() already set the index — restart iteration
        if (this.indexOverridden) {
          this.indexOverridden = false
          continue
        }
        continue
      }

      this.indexOverridden = false
      const task = this.tasks[this.index]
      updateTourProgress(this.index, this.tasks.length)
      logger.debug(`[Tour] Step ${this.index + 1}/${this.tasks.length}:`, task)

      try {
        await this.executeTask(task)
      } catch (err) {
        if (this.isStopped()) return
        logger.warn('[Tour] Task failed, skipping:', err)
      }

      if (this.isStopped()) return

      // If next()/prev() changed the index during task execution
      // (e.g. during pauseForInput), don't auto-advance.
      if (this.indexOverridden) {
        this.indexOverridden = false
      } else {
        this.index++
      }
    }

    // Reached the end
    logger.info('[Tour] Tour complete')
    this._state = 'stopped'
    this.cleanup()
    this.callbacks.onTourEnd()
  }

  // ── Task dispatch ──────────────────────────────────────────────────

  private async executeTask(def: TourTaskDef): Promise<void> {
    const [key, value] = identifyTask(def)

    switch (key) {
      // Camera
      case 'flyTo':
        return this.execFlyTo(value as FlyToTaskParams)
      case 'tiltRotateCamera':
        return this.execTiltRotateCamera(value as TiltRotateCameraTaskParams)
      case 'resetCameraZoomOut':
      case 'resetCameraAndZoomOut':
        return this.execResetCameraZoomOut()

      // Flow
      case 'pauseForInput':
        return this.execPauseForInput()
      case 'pauseSeconds':
      case 'pauseSec':
        return this.execPauseSeconds(value as number)
      case 'loopToBeginning':
        return this.execLoopToBeginning()
      case 'enableTourPlayer':
      case 'tourPlayerWindow':
        return this.execEnableTourPlayer(value as 'on' | 'off')
      case 'question':
        return this.execQuestion(value as QuestionTaskParams)

      // Dataset
      case 'loadDataset':
        return this.execLoadDataset(value as { id: string; showLegend?: boolean })
      case 'unloadAllDatasets':
        return this.execUnloadAll()
      case 'datasetAnimation':
        return this.execDatasetAnimation(value as DatasetAnimationTaskParams)

      // Environment
      case 'envShowDayNightLighting':
        return this.execDayNight(value as 'on' | 'off')
      case 'envShowClouds':
        return this.execClouds(value as 'on' | 'off')
      case 'envShowEarth':
        // Toggle globe visibility — 'off' hides for full-screen media overlays
        logger.info(`[Tour] Earth visibility: ${value}`)
        return
      case 'envShowWorldBorder':
        return this.execWorldBorder(value as 'on' | 'off')
      case 'worldBorder':
        return this.execWorldBorderObj(value as { worldBorders: 'on' | 'off' })
      case 'envShowStars':
        // Stars aren't rendered in the web app — log and skip
        logger.info('[Tour] Stars toggle not supported in web player')
        return
      case 'setGlobeRotationRate':
        return this.execRotationRate(value as number)

      // Media
      case 'playAudio':
        return this.execPlayAudio(value as PlayAudioTaskParams)
      case 'stopAudio':
        this.stopActiveAudio()
        return
      case 'playVideo':
      case 'showVideo':
        return this.execPlayVideo(value as PlayVideoTaskParams)
      case 'hideVideo':
      case 'hidePlayVideo':
      case 'stopVideo': {
        const raw = value as string
        if (!raw) {
          // Empty string means hide all videos (SOS convention)
          hideAllTourVideos()
        } else {
          hideTourVideo(this.callbacks.resolveMediaUrl(raw))
        }
        return
      }
      case 'showImage':
      case 'showImg':
        return this.execShowImage(value as ShowImageTaskParams)
      case 'hideImage':
      case 'hideImg':
        hideTourImage(value as string)
        return
      case 'showPopupHtml':
        return this.execShowPopupHtml(value as ShowPopupHtmlTaskParams)
      case 'hidePopupHtml':
        hideTourPopup(value as string)
        return

      // Resources
      case 'showRect':
        showTourTextBox(value as ShowRectTaskParams)
        return
      case 'hideRect':
        hideTourTextBox(value as string)
        return
      case 'addPlacemark':
        return this.execAddPlacemark(value as AddPlacemarkTaskParams)
      case 'hidePlacemark':
        this.execHidePlacemark(value as string)
        return

      default:
        logger.info(`[Tour] Skipping unknown task: ${key}`)
    }
  }

  // ── Camera executors ───────────────────────────────────────────────

  private async execFlyTo(params: FlyToTaskParams): Promise<void> {
    const renderer = this.callbacks.getRenderer()
    const altKm = params.altmi * MI_TO_KM * SOS_ALTITUDE_SCALE

    if (params.animated === false) {
      // Instant jump — use map.jumpTo if available
      const map = renderer.getMap?.() as any
      if (map?.jumpTo) {
        const zoom = Math.log2(6371 * 2 / Math.max(altKm, 1))
        map.jumpTo({ center: [params.lon, params.lat], zoom })
        return
      }
    }
    await renderer.flyTo(params.lat, params.lon, altKm)
  }

  private async execTiltRotateCamera(params: TiltRotateCameraTaskParams): Promise<void> {
    const renderer = this.callbacks.getRenderer()
    // tiltRotateCamera sets pitch and bearing via the underlying map
    const map = renderer.getMap?.() as any
    if (!map) return

    if (params.animated) {
      await new Promise<void>(resolve => {
        map.once('moveend', () => resolve())
        map.easeTo({
          pitch: params.tilt,
          bearing: params.rotate,
          duration: 2500,
        })
      })
    } else {
      map.jumpTo({ pitch: params.tilt, bearing: params.rotate })
    }
  }

  private async execResetCameraZoomOut(): Promise<void> {
    const renderer = this.callbacks.getRenderer()
    const map = renderer.getMap?.() as any
    if (!map) return

    await new Promise<void>(resolve => {
      map.once('moveend', () => resolve())
      map.flyTo({
        center: [-95, 38],
        zoom: 2.3,
        pitch: 0,
        bearing: 0,
        duration: 2000,
      })
    })
  }

  // ── Flow executors ─────────────────────────────────────────────────

  private async execPauseForInput(): Promise<void> {
    await this.pauseAndWait('Tour paused — press play to continue')
  }

  /**
   * Pause the tour and wait for the user to resume via play(). Used by
   * pauseForInput and by media executors that need a user gesture to
   * unblock browser autoplay policies.
   */
  private async pauseAndWait(message: string): Promise<void> {
    this._state = 'paused'
    updateTourPlayState(false)
    this.callbacks.announce(message)
    await new Promise<void>(resolve => { this.resumeResolver = resolve })
  }

  private async execPauseSeconds(seconds: number): Promise<void> {
    await new Promise<void>(resolve => {
      this.pauseTimerResolver = resolve
      this.pauseTimer = setTimeout(() => {
        this.pauseTimer = null
        this.pauseTimerResolver = null
        resolve()
      }, seconds * 1000)
    })
  }

  private execLoopToBeginning(): void {
    // Set index to -1 because the loop will increment it to 0
    this.index = -1
    logger.info('[Tour] Looping to beginning')
  }

  private execEnableTourPlayer(state: 'on' | 'off'): void {
    if (state === 'on') {
      showControls(this, () => this.callbacks.onStop())
    } else {
      hideControls()
    }
  }

  private async execQuestion(params: QuestionTaskParams): Promise<void> {
    const questionUrl = this.callbacks.resolveMediaUrl(params.imgQuestionFilename)
    const answerUrl = this.callbacks.resolveMediaUrl(params.imgAnswerFilename)

    return new Promise<void>(resolve => {
      showTourQuestion({
        ...params,
        imgQuestionFilename: questionUrl,
        imgAnswerFilename: answerUrl,
        onComplete: resolve,
      })
    })
  }

  // ── Dataset executors ──────────────────────────────────────────────

  private async execLoadDataset(params: { id: string; showLegend?: boolean; [key: string]: unknown }): Promise<void> {
    await this.callbacks.loadDataset(params.id)
    hideTourLegend() // clear any previous legend

    if (params.showLegend) {
      const isMobile = window.innerWidth <= 768
      if (isMobile) {
        // On mobile, show a floating legend thumbnail (info panel is hidden)
        const legendEl = document.querySelector('.info-legend-thumb') as HTMLImageElement | null
        if (legendEl?.src) {
          showTourLegend(legendEl.src)
        }
      } else {
        // On desktop, expand the info panel so the legend is visible
        const infoPanel = document.getElementById('info-panel')
        const infoHeader = document.getElementById('info-header')
        if (infoPanel && !infoPanel.classList.contains('expanded')) {
          infoPanel.classList.add('expanded')
          infoHeader?.setAttribute('aria-expanded', 'true')
        }
      }
    }
  }

  private async execUnloadAll(): Promise<void> {
    hideTourLegend()
    await this.callbacks.unloadAllDatasets()
  }

  private execDatasetAnimation(params: DatasetAnimationTaskParams): void {
    // Apply requested frame rate as a playback speed ratio.
    // Videos are encoded at ~30fps; "5 fps" means playbackRate = 5/30.
    if (params.frameRate) {
      const match = params.frameRate.match(/^(\d+(?:\.\d+)?)\s*fps$/i)
      if (match) {
        const requestedFps = parseFloat(match[1])
        const defaultFps = 30
        const rate = Math.max(0.03, Math.min(4, requestedFps / defaultFps))
        logger.info(`[Tour] Setting playback rate: ${requestedFps} fps → ${rate.toFixed(3)}x`)
        this.callbacks.setPlaybackRate(rate)
      }
    }

    if (params.animation === 'on' && !this.callbacks.isPlaying()) {
      this.callbacks.togglePlayPause()
    } else if (params.animation === 'off' && this.callbacks.isPlaying()) {
      this.callbacks.togglePlayPause()
    }
  }

  // ── Environment executors ──────────────────────────────────────────

  private execDayNight(state: 'on' | 'off'): void {
    const renderer = this.callbacks.getRenderer()
    if (state === 'on') {
      const sun = getSunPosition(new Date())
      renderer.enableSunLighting(sun.lat, sun.lng)
    } else {
      renderer.disableSunLighting()
    }
  }

  private async execClouds(state: 'on' | 'off'): Promise<void> {
    const renderer = this.callbacks.getRenderer()
    if (state === 'on') {
      const cloudUrl = getCloudTextureUrl()
      await renderer.loadCloudOverlay(cloudUrl)
    } else {
      renderer.removeCloudOverlay()
    }
  }

  private execWorldBorder(state: 'on' | 'off'): void {
    const renderer = this.callbacks.getRenderer()
    const on = state === 'on'
    renderer.toggleBoundaries?.(on)
    renderer.toggleLabels?.(on)
    syncMapControlState(on, on)
  }

  private execWorldBorderObj(params: { worldBorders: 'on' | 'off' }): void {
    this.execWorldBorder(params.worldBorders)
  }

  private execRotationRate(rate: number): void {
    const renderer = this.callbacks.getRenderer()
    if (renderer.setRotationRate) {
      renderer.setRotationRate(rate)
    }
    // No fallback to toggleAutoRotate — it's not idempotent and can't
    // represent specific rates. setRotationRate is always available on
    // MapRenderer, the only GlobeRenderer implementation.
  }

  // ── Media executors ────────────────────────────────────────────────

  private async execPlayAudio(params: PlayAudioTaskParams): Promise<void> {
    this.stopActiveAudio()
    const url = this.callbacks.resolveMediaUrl(params.filename)
    const audio = new Audio(url)
    this.activeAudio = audio

    // Start playback. If autoplay is blocked by browser policy, pause the
    // tour so the user's subsequent play-button click provides a gesture,
    // then retry once. A second failure is reported normally.
    const startPlayback = async (): Promise<void> => {
      try {
        await audio.play()
      } catch (err) {
        if (err instanceof DOMException && err.name === 'NotAllowedError') {
          logger.warn('[Tour] Audio autoplay blocked — pausing for user gesture')
          await this.pauseAndWait('Audio blocked by browser — press play to continue')
          if (this.isStopped() || audio !== this.activeAudio) return
          await audio.play()
        } else {
          throw err
        }
      }
    }

    if (params.asynchronous) {
      // Fire and forget — don't wait for completion
      startPlayback().catch(err => logger.warn('[Tour] Audio play failed:', err))
    } else {
      await startPlayback()
      if (this.isStopped() || audio !== this.activeAudio) return
      // Wait for audio to finish
      await new Promise<void>((resolve, reject) => {
        audio.addEventListener('ended', () => resolve(), { once: true })
        audio.addEventListener('error', () => reject(new Error('Audio playback failed')), { once: true })
      })
    }
  }

  private stopActiveAudio(): void {
    if (this.activeAudio) {
      this.activeAudio.pause()
      this.activeAudio.src = ''
      this.activeAudio = null
    }
  }

  private execPlayVideo(params: PlayVideoTaskParams): void {
    const url = this.callbacks.resolveMediaUrl(params.filename)
    showTourVideo({
      ...params,
      filename: url,
    })
  }

  private execShowImage(params: ShowImageTaskParams): void {
    const url = this.callbacks.resolveMediaUrl(params.filename)
    showTourImage({
      ...params,
      filename: url,
    })
  }

  private execShowPopupHtml(params: ShowPopupHtmlTaskParams): void {
    const resolved = params.url
      ? { ...params, url: this.callbacks.resolveMediaUrl(params.url) }
      : params
    showTourPopup(resolved)
  }

  // ── Placemark executors ────────────────────────────────────────────

  private execAddPlacemark(params: AddPlacemarkTaskParams): void {
    const renderer = this.callbacks.getRenderer()
    if (renderer.addMarker) {
      const marker = renderer.addMarker(params.lat, params.lon, params.name)
      if (marker) {
        this.activePlacemarks.set(params.placemarkID, marker)
      }
    }
  }

  private execHidePlacemark(id: string): void {
    const marker = this.activePlacemarks.get(id)
    if (marker && typeof (marker as any).remove === 'function') {
      (marker as any).remove()
      this.activePlacemarks.delete(id)
    }
  }

  private clearPlacemarks(): void {
    for (const [, marker] of this.activePlacemarks) {
      if (typeof (marker as any).remove === 'function') {
        (marker as any).remove()
      }
    }
    this.activePlacemarks.clear()
  }
}
