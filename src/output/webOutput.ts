// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The output page's web mode, composed (`docs/SECOND_LIFE_COMPAT.md` §7).
 *
 * Off desktop there is no control window. In Second Life every
 * visitor's viewer runs its own copy, so the page's address says what
 * to show (`webMode.ts`). This module turns each reading of the address
 * into the scene, the mirror and the clock. `main.ts` calls `apply` at
 * load and on every `hashchange`, and `steer` every frame.
 *
 * Its own module, not inline in `main.ts`, because the ordering here
 * has wrong answers and `main.ts` exports nothing to test them through.
 * The first version was inline, and review found two races in it.
 *
 * **The mirror is the truth, and it is redrawn after every apply.** The
 * inline version redrew only when the request was still the newest. So
 * when the address moved on while a load was landing, the mirror took
 * the load and released what was on screen, and the scene went on
 * sampling the released element. This redraws whatever the mirror holds
 * when any apply resolves. That is idempotent, and it is never wrong.
 *
 * **Every copy converges on the same picture.** A dataset that will not
 * load leaves the live Earth up, whether or not something was showing
 * before. Otherwise a copy that had A keeps A while a copy loading fresh
 * shows nothing, and visitors at one globe see different things. A
 * failure to load is retried with backoff for as long as the address
 * still asks for that dataset, because a permanent exhibit should
 * recover from a blip without anyone touching it. That covers an HTTP
 * error, a network error, a body cut short or not JSON (a proxy's error
 * page served as 200), and a picture that would not decode. A manifest
 * that disagrees with its record is retried too, which is harmless at
 * the slow end of the backoff and right if the node is mid-deploy. Only a
 * dataset the node says does not exist, or cannot put on a sphere, is
 * not retried. Copies converge rather than agree at every instant:
 * during a load, and for up to one retry interval after the node
 * recovers, they can differ.
 *
 * **A stream that dies after it loaded is not retried here.** The mirror
 * keeps its last frame and reports nothing; noticing that and rebuilding
 * the stream is the multi-monitor plan's rung 13, for desktop and web
 * alike. A short loop is safe once it is fully buffered.
 */

import type { DatasetMirror } from './datasetMirror'
import { IDENTITY_PARAMS } from './equirectRtt'
import type { OutputScene } from './outputScene'
import type { SyncOutcome } from './outputSync'
import { createWebClockSteer } from './webClock'
import { WebDatasetError, fetchWebDataset, type WebDataset } from './webDataset'
import type { WebTelemetry } from './webTelemetry'
import {
  defaultWebFramebufferWidth,
  readWebSettings,
  rotationOffsetRadFor,
  sameClock,
  type WebOutputSettings,
} from './webMode'
import type { FramebufferWidth, MirroredDataset } from '../services/multiOutput/protocol'
import { logger } from '../utils/logger'

/** Waits before each retry of a failure that may be temporary; the last
 *  repeats for as long as the address asks for the dataset. */
export const RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000, 300_000]

/** The page as displayed, in device pixels. */
export interface DisplaySize {
  width: number
  height: number
}

/**
 * The framebuffer a reading of the address asks for: its `width`, or the
 * width the picture is shown at (`defaultWebFramebufferWidth`).
 *
 * Shown, not the canvas box: letterboxed, a page wider than 2:1 shows a
 * picture twice its height wide, and sizing to the box drew a 4096 frame
 * to show 2048 pixels (found in review). Stretched, the frame has to
 * cover both directions, so a page taller than 2:1, a square face say,
 * takes a frame twice its height wide. That costs a 1024 square face
 * the 2048 stream and four times the pixels of a 1024 frame, every
 * visitor, and it is what full vertical resolution takes there; an
 * address that would rather save the bandwidth says `width=1024`. Read
 * when the address is
 * applied, at load and on every `#` change; a resize alone is not
 * followed.
 */
export function framebufferFor(settings: WebOutputSettings, display: DisplaySize): FramebufferWidth {
  const shownPx =
    settings.fit === 'fill'
      ? Math.max(display.width, 2 * display.height)
      : Math.min(display.width, 2 * display.height)
  return settings.framebufferWidth ?? defaultWebFramebufferWidth(shownPx)
}

/** Whether a failure to show a dataset is worth trying again: anything
 *  but the node saying it has no such dataset, or none it can show. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof WebDatasetError) return err.failure !== 'not_found' && err.failure !== 'not_playable'
  // A network error, or the picture itself not loading.
  return true
}

/** The page's address and its `hashchange`, as `followAddress` reads
 *  them. `window` is one. */
export interface AddressSource {
  readonly location: { readonly search: string; readonly hash: string }
  addEventListener(type: 'hashchange', listener: () => void): void
  removeEventListener(type: 'hashchange', listener: () => void): void
}

/**
 * Apply the address now and on every `#` change, which a browser makes
 * without a reload. Returns a function that stops listening.
 *
 * It reads the address itself, at the moment it starts listening, and
 * takes no earlier reading. `main.ts` reads the address once before the
 * scene exists, to size the first frame, and the scene's lazy imports
 * are awaited between that and this. A `#` change during the wait fires
 * a `hashchange` nobody hears, so applying the earlier reading left the
 * copy on the old dataset or clock until the next change (found in
 * review). Reading and listening here are one synchronous step, so
 * nothing falls between them.
 */
export function followAddress(target: AddressSource, apply: (settings: WebOutputSettings) => void): () => void {
  const read = (): void => apply(readWebSettings(target.location.search, target.location.hash))
  read()
  target.addEventListener('hashchange', read)
  return () => target.removeEventListener('hashchange', read)
}

export interface WebOutputDeps {
  mirror: Pick<DatasetMirror, 'apply' | 'current' | 'currentDataset'>
  scene: Pick<OutputScene, 'size' | 'setLayers' | 'setFramebufferWidth' | 'setParams'>
  /** Show or hide the debug HUD. */
  setDebug(on: boolean): void
  /** Stretch the canvas to the page, or letterbox it. */
  setFill(on: boolean): void
  /** The page as displayed, in device pixels. */
  displaySizePx(): DisplaySize
  /** Ask for a frame: something changed the scene can't see. */
  markDirty(): void
  fetchDataset?: (id: string, opts: { frameWidth: number }) => Promise<WebDataset>
  /** Start the page's own telemetry (`webTelemetry.ts`), the first time
   *  an address turns it on. Absent, the page reports nothing. */
  loadTelemetry?: () => Promise<WebTelemetry | null>
  /** Wall-clock milliseconds, for the clock's anchor. */
  nowMs?: () => number
  /** Monotonic milliseconds, for how long a dataset took to show. */
  monotonicMs?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface WebOutput {
  /** Apply a reading of the address: at load, and on every `hashchange`. */
  apply(settings: WebOutputSettings): void
  /** Steer the video to the clock. Every frame. */
  steer(): SyncOutcome
  /** A fatal error from the stream, reported if the address has
   *  telemetry on. */
  reportStreamError(err: Error): void
  dispose(): void
}

const NOT_READY: SyncOutcome = { kind: 'not-ready', driftS: null, seeked: false }

export function createWebOutput(deps: WebOutputDeps): WebOutput {
  const { mirror, scene } = deps
  const fetchDataset = deps.fetchDataset ?? fetchWebDataset
  const nowMs = deps.nowMs ?? (() => Date.now())
  const monotonicMs = deps.monotonicMs ?? (() => performance.now())
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const clockSteer = createWebClockSteer()

  let current: WebOutputSettings | null = null
  let disposed = false
  /** The page's telemetry, once an address has turned it on. */
  let telemetry: Promise<WebTelemetry | null> | null = null
  /**
   * Report only while the address says so: checked when the report is
   * made and again when it is delivered, so a `#telemetry=0` stops it as
   * soon as it is applied, like every other setting. Turning it off
   * stops this page sending more; what it already queued may still go.
   */
  const report = (send: (t: WebTelemetry) => void): void => {
    if (!telemetry || !current?.telemetry || disposed) return
    void telemetry.then(t => {
      if (t && current?.telemetry && !disposed) send(t)
    })
  }
  /** When this copy read the clock: the anchor for one with no `at`. */
  let clockReadAtMs = nowMs()
  /** A newer address wins over a slower fetch, the rule `datasetMirror`
   *  applies to loads, one step earlier. */
  let generation = 0
  let retryTimer: unknown = null
  /** Whether the element was mid-seek at the last steer. */
  let wasSeeking = false

  // From the mirror, as on desktop: what this window decoded, not what
  // the address asked for.
  const recomposite = (): void => {
    if (disposed) return
    const media = mirror.current()
    const shown = mirror.currentDataset()
    scene.setLayers(media && shown ? [{ kind: media.kind, element: media.element, overlay: shown.overlay }] : [])
    deps.markDirty()
  }

  const apply = async (dataset: MirroredDataset | null): Promise<void> => {
    await mirror.apply(dataset)
    recomposite()
  }

  const cancelRetry = (): void => {
    if (retryTimer !== null) clearTimer(retryTimer)
    retryTimer = null
  }

  /** Try each address in turn, until one is on screen or the address
   *  moved on. */
  const tryCandidates = async (found: WebDataset, mine: number): Promise<'shown' | 'superseded' | 'failed'> => {
    for (const url of [found.dataset.url, ...found.alternateUrls]) {
      if (mine !== generation || disposed) return 'superseded'
      const candidate = url === found.dataset.url ? found.dataset : { ...found.dataset, url }
      await apply(candidate)
      // On screen, but counted as shown only while it is still what the
      // address asks for: the next address may still be fetching.
      if (mirror.currentDataset() === candidate) return mine === generation && !disposed ? 'shown' : 'superseded'
    }
    return 'failed'
  }

  /** `startedMs` is when the address asked for the dataset, kept across
   *  retries so a load time counts from there, not from the last retry. */
  const showDataset = (id: string | null, attempt = 0, startedMs = monotonicMs()): void => {
    const mine = ++generation
    cancelRetry()
    if (id === null) {
      void apply(null)
      return
    }
    void (async () => {
      let failure: unknown
      try {
        const found = await fetchDataset(id, { frameWidth: scene.size.width })
        if (mine !== generation || disposed) return
        const outcome = await tryCandidates(found, mine)
        if (outcome === 'superseded') return
        if (outcome === 'shown') {
          const loadMs = monotonicMs() - startedMs
          report(t => t.datasetShown(found.dataset, loadMs))
          return
        }
        failure = new Error(`no address for ${id} would load`)
      } catch (err) {
        failure = err
      }
      if (mine !== generation || disposed) return
      logger.error(`[Output] could not show dataset ${id}:`, failure)
      // The first failure of each address, not its retries.
      if (attempt === 0) report(t => t.datasetFailed(failure))
      // The live Earth, so every copy at one globe agrees on what it
      // could not show.
      await apply(null)
      if (mine !== generation || disposed || !isRetryable(failure)) return
      const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]
      retryTimer = setTimer(() => {
        retryTimer = null
        if (mine === generation && !disposed) showDataset(id, attempt + 1, startedMs)
      }, delay)
    })()
  }

  return {
    apply(next) {
      if (disposed) return
      const previous = current
      current = next
      // No-ops on an unchanged snapped size, so a fragment change that
      // only moved the clock reallocates nothing.
      scene.setFramebufferWidth(framebufferFor(next, deps.displaySizePx()))
      deps.setFill(next.fit === 'fill')
      scene.setParams({ ...IDENTITY_PARAMS, rotationOffsetRad: rotationOffsetRadFor(next.centreLonDeg) })
      deps.setDebug(next.debug)
      // Before the dataset, so a dataset this address shows is reported.
      // Loaded once; turning it off later gates it in `report`.
      // A dataset already on the glass when it turns on is not counted:
      // only what an address shows while it is on.
      if (next.telemetry && !telemetry && deps.loadTelemetry) {
        telemetry = deps.loadTelemetry().catch(() => null)
      }
      if (!previous || !sameClock(next.clock, previous.clock)) clockReadAtMs = nowMs()
      if (!previous || next.datasetId !== previous.datasetId) showDataset(next.datasetId)
      deps.markDirty()
    },

    reportStreamError(err) {
      report(t => t.streamError(err))
    },

    steer() {
      const video = mirror.current()?.video ?? null
      if (!video || !current) {
        wasSeeking = false
        return NOT_READY
      }
      const before = video.currentTime
      const outcome = clockSteer.steer(video, current.clock, nowMs(), clockReadAtMs)
      // A seek changes the decoded frame without the scene knowing, and
      // so does a seek *landing*. A paused element counts as static, so
      // without the second the new frame waited out the 1 Hz floor, up
      // to a second on each copy at its own phase.
      if (before !== video.currentTime || (wasSeeking && !video.seeking)) deps.markDirty()
      wasSeeking = video.seeking
      return outcome
    },

    dispose() {
      disposed = true
      generation++
      cancelRetry()
    },
  }
}
