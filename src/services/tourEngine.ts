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
} from '../types'
import { showTourTextBox, hideTourTextBox, hideAllTourTextBoxes, updateTourProgress } from '../ui/tourUI'

// Miles → kilometres
const MI_TO_KM = 1.60934

/**
 * Determine which task key is present in a TourTaskDef and return [key, value].
 */
function identifyTask(def: TourTaskDef): [string, unknown] {
  const key = Object.keys(def)[0]
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

  // Abort handle — when the tour is stopped, pending awaits should bail out
  private abortController = new AbortController()

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
      this.resumeResolver()
      this.resumeResolver = null
      return
    }

    if (this._state === 'playing') return

    this._state = 'playing'
    this.abortController = new AbortController()
    await this.runLoop()
  }

  /** Pause the tour. If currently executing a flyTo or timed pause, it will
   *  finish the current task but stop before the next one. */
  pause(): void {
    if (this._state !== 'playing') return
    this._state = 'paused'
  }

  /** Advance to the next task (skipping any current pause). */
  next(): void {
    if (this.index < this.tasks.length - 1) {
      // If paused on a pauseForInput, resolve it to advance
      if (this.resumeResolver) {
        this.resumeResolver()
        this.resumeResolver = null
      }
      if (this.pauseTimer) {
        clearTimeout(this.pauseTimer)
        this.pauseTimer = null
      }
      // If stopped, just bump the index — play() will pick it up
      if (this._state === 'stopped') {
        this.index++
        updateTourProgress(this.index, this.tasks.length)
      }
    }
  }

  /** Go back to the previous task. */
  prev(): void {
    if (this.index > 0) {
      this.index = Math.max(0, this.index - 1)
      updateTourProgress(this.index, this.tasks.length)
      // If paused on input, resolve so the loop can re-enter at the new index
      if (this.resumeResolver) {
        this.resumeResolver()
        this.resumeResolver = null
      }
    }
  }

  /** Stop and reset the tour. */
  stop(): void {
    this._state = 'stopped'
    this.abortController.abort()
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer)
      this.pauseTimer = null
    }
    if (this.resumeResolver) {
      this.resumeResolver()
      this.resumeResolver = null
    }
    hideAllTourTextBoxes()
    this.callbacks.onTourEnd()
  }

  /** Read current state without TS narrowing (state can change during awaits). */
  private isStopped(): boolean { return this._state === 'stopped' }

  // ── Main execution loop ────────────────────────────────────────────

  private async runLoop(): Promise<void> {
    while (this.index < this.tasks.length) {
      if (this.isStopped()) return
      if (this._state === 'paused') {
        // Wait for resume
        await new Promise<void>(resolve => { this.resumeResolver = resolve })
        if (this.isStopped()) return
        continue // re-check index (prev/next may have changed it)
      }

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
      this.index++
    }

    // Reached the end
    logger.info('[Tour] Tour complete')
    this._state = 'stopped'
    hideAllTourTextBoxes()
    this.callbacks.onTourEnd()
  }

  // ── Task dispatch ──────────────────────────────────────────────────

  private async executeTask(def: TourTaskDef): Promise<void> {
    const [key, value] = identifyTask(def)

    switch (key) {
      case 'flyTo':
        return this.execFlyTo(value as FlyToTaskParams)
      case 'showRect':
        return this.execShowRect(value as ShowRectTaskParams)
      case 'hideRect':
        hideTourTextBox(value as string)
        return
      case 'pauseForInput':
        return this.execPauseForInput()
      case 'pauseSeconds':
        return this.execPauseSeconds(value as number)
      case 'loadDataset':
        return this.execLoadDataset((value as { id: string }).id)
      case 'unloadAllDatasets':
        return this.execUnloadAll()
      case 'datasetAnimation':
        return this.execDatasetAnimation(value as DatasetAnimationTaskParams)
      case 'envShowDayNightLighting':
        return this.execDayNight(value as 'on' | 'off')
      case 'envShowClouds':
        return this.execClouds(value as 'on' | 'off')
      case 'setGlobeRotationRate':
        return this.execRotationRate(value as number)
      case 'question':
        // Phase 2 — skip for now
        logger.info('[Tour] Skipping unsupported task: question')
        return
      default:
        logger.info(`[Tour] Skipping unknown task: ${key}`)
    }
  }

  // ── Individual task executors ──────────────────────────────────────

  private async execFlyTo(params: FlyToTaskParams): Promise<void> {
    const renderer = this.callbacks.getRenderer()
    const altKm = params.altmi * MI_TO_KM
    if (params.animated) {
      await renderer.flyTo(params.lat, params.lon, altKm)
    } else {
      // Instant jump — flyTo with 0 duration isn't exposed, so use a very
      // short animated flyTo as a pragmatic substitute.
      await renderer.flyTo(params.lat, params.lon, altKm)
    }
  }

  private execShowRect(params: ShowRectTaskParams): void {
    showTourTextBox(params)
  }

  private async execPauseForInput(): Promise<void> {
    this._state = 'paused'
    this.callbacks.announce('Tour paused — press play to continue')
    await new Promise<void>(resolve => { this.resumeResolver = resolve })
  }

  private async execPauseSeconds(seconds: number): Promise<void> {
    await new Promise<void>(resolve => {
      this.pauseTimer = setTimeout(() => {
        this.pauseTimer = null
        resolve()
      }, seconds * 1000)
    })
  }

  private async execLoadDataset(id: string): Promise<void> {
    await this.callbacks.loadDataset(id)
  }

  private async execUnloadAll(): Promise<void> {
    await this.callbacks.unloadAllDatasets()
  }

  private execDatasetAnimation(params: DatasetAnimationTaskParams): void {
    if (params.animation === 'on' && !this.callbacks.isPlaying()) {
      this.callbacks.togglePlayPause()
    } else if (params.animation === 'off' && this.callbacks.isPlaying()) {
      this.callbacks.togglePlayPause()
    }
  }

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

  private execRotationRate(rate: number): void {
    const renderer = this.callbacks.getRenderer()
    if (rate > 0) {
      // Use setRotationRate if available, otherwise toggle auto-rotate
      if ('setRotationRate' in renderer && typeof (renderer as any).setRotationRate === 'function') {
        (renderer as any).setRotationRate(rate)
      } else {
        renderer.toggleAutoRotate()
      }
    }
  }
}
