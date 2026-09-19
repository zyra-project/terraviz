// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Output window entry point.
 *
 * Deliberately thin — the same shape `orbitMain.ts` has over
 * `orbitCharacter/`, so everything worth testing lives in
 * `outputScene.ts`, `outputLink.ts`, `datasetMirror.ts` and
 * `outputSync.ts`, each importable without running a page. What is left
 * here is the composition, and two decisions that only make sense at
 * this level.
 *
 * **The link is optional; the page is not.** `output.html` is also the
 * static fixture the plan's rungs 2-4 render in an ordinary browser, and
 * a scene that refused to draw without Tauri would take that away. So
 * the link is attached only on desktop and its failure costs the link,
 * never the render loop — an output showing a correct idle Earth is a
 * far better failure than a black window.
 *
 * **Playback is steered per frame, not per message.** A diff tells the
 * output where the primary *was* when it was sent; between diffs both
 * clocks keep running. `outputSync` is idempotent in the steady state —
 * inside the hard-seek threshold it only trims the rate — so calling it
 * every frame is what keeps a sphere in step rather than sawtoothing
 * between diffs.
 */

import './output.css'
import { CALIBRATION_OVERLAY, createCalibrationCache } from './calibrationPattern'
import { createDatasetMirror } from './datasetMirror'
import {
  OVERLAY_REFRESH_MS,
  createDebugOverlay,
  createDrawTimer,
  createFpsMeter,
} from './debugOverlay'
import {
  STATE_KEYS,
  changesPicture,
  connectOutputLink,
  createTauriLinkHost,
  type StateKey,
} from './outputLink'
import {
  contentKindFor,
  createOutputScene,
  shouldRenderFrame,
  advanceFrameDeadline,
  type OutputLayerInput,
} from './outputScene'
import type { LinkHealth } from './linkWatchdog'
import type { SyncOutcome } from './outputSync'
import { createFullscreenController, resolveChromeHost } from '../services/windowChrome'
import type { OutputGlobeState, OutputRenderConfig } from '../services/multiOutput/protocol'
import { logger } from '../utils/logger'

/** The same gate `bootMultiOutput` applies on the control side. */
function isDesktop(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean((window as unknown as { __TAURI__?: unknown }).__TAURI__)
  )
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('output-canvas')
  if (!(canvas instanceof HTMLCanvasElement)) {
    logger.error('[Output] no #output-canvas in the page')
    return
  }

  const scene = await createOutputScene({ canvas })
  const mirror = createDatasetMirror()
  /** Per-frame work the link installs, if it attached. Empty on the web
   *  fixture page, where the loop is just the idle Earth. */
  const steerers: (() => void)[] = []

  /** When the next frame is due, carried across callbacks rather than
   *  re-derived from the last draw. That is what keeps the rate right
   *  on a display whose refresh is not a multiple of the cap — see
   *  `shouldRenderFrame`. Zero until the first draw sets it. */
  let dueMs = 0
  // First tick always draws: nothing has been shown yet, and a black
  // canvas is indistinguishable from a failed boot on a projector.
  let dirty = true

  const fpsMeter = createFpsMeter()
  let fps = 0
  let lastFpsSample = 0
  /** How long a draw actually costs, which fps cannot say: it is capped
   *  at 30 by the frame gate, floored at 1 Hz by the static rung, and
   *  while the camera moves it is ceilinged by the *control* window's
   *  render rate, because that is what sets `dirty`. Sampled on the same
   *  timer as fps so the two are read as one pair. */
  const drawTimer = createDrawTimer()
  let drawMs: number | null = null
  /** How often the browser calls this loop, against how often the loop
   *  draws. Ticked on every callback rather than on drawn frames, which
   *  is the whole point: `fps` is the rate this app *took* and this is
   *  the rate it was *offered*, and the first reading is unreadable
   *  without the second. A sub-millisecond `draw` rules out CPU cost in
   *  the render; it says nothing about the GPU, because an overrunning
   *  GPU blocks at present — between callbacks, where it shows up here
   *  and nowhere else. */
  const rafMeter = createFpsMeter()
  let rafHz = 0
  /** When the previous callback ran, so the frame gate knows how often
   *  it is being *offered* one. Without it the gate aliases against a
   *  display whose refresh equals the cap — see `shouldRenderFrame`. */
  let lastCallback: number | null = null
  /** The last correction `outputSync` computed, reported by the HUD
   *  rather than recomputed there — see `SyncOutcome.driftS`. */
  let lastSync: SyncOutcome | null = null
  /** Queried once and remembered. The string is fixed for the life of
   *  the GL context, and `undefined` — not `null` — is the "not asked
   *  yet" marker, so a driver that *refuses* the query is not re-asked
   *  twice a second for the life of the installation. */
  /**
   * The link's health, read by the HUD before the link exists.
   *
   * The overlay is mounted unconditionally and the link attaches on
   * desktop only, inside a `try` that is allowed to fail — so the HUD
   * outlives every case where there is no link to ask. `live` is the
   * honest default rather than a hedge: the static fixture page and a
   * failed attach both have no control window to have gone quiet on
   * them, and reporting `orphaned` there would put a fault on screen
   * for a window that is working exactly as intended.
   */
  let readLinkHealth: () => LinkHealth = () => 'live'

  /**
   * Whether the calibration pattern is what is on the glass.
   *
   * Hoisted and defaulted for `readLinkHealth`'s reason — the HUD is
   * mounted before the link exists and outlives a failed attach — and
   * `false` is honest there, since a window with no manager has nobody
   * to have turned it on.
   *
   * The HUD needs it because its `dataset` field answers *what is on
   * the glass*, not what was mirrored, and calibration is the one state
   * where the mirror still holds a dataset that is not being shown.
   * Without this the HUD names a dataset over a test pattern, which is
   * the precise thing its "mirror, not link" rule exists to prevent,
   * arriving from the other side.
   */
  let readCalibration: () => boolean = () => false

  let gpu: string | null | undefined
  const gpuName = (): string | null => {
    if (gpu === undefined) gpu = scene.rendererName()
    return gpu
  }

  // Mounted unconditionally and hidden. It costs one no-op timer
  // callback twice a second — `refresh` returns before reading anything
  // while hidden — and in exchange the toggle is instant, which is what
  // an operator standing at the sphere is actually doing with it.
  const overlay = createDebugOverlay(() => ({
    // The mirror, not the link: what this window decoded, not what the
    // control window last said. During a load those differ, and the
    // useful answer is what is on the glass — which is also why
    // calibration wins over both.
    datasetId: readCalibration()
      ? (CALIBRATION_OVERLAY.datasetId ?? null)
      : (mirror.currentDataset()?.id ?? null),
    driftS: lastSync?.driftS ?? null,
    syncKind: lastSync?.kind ?? null,
    fps,
    drawMs,
    rafHz,
    // Read, never evaluated: `linkHealth()` is the pure getter, so
    // painting the HUD cannot itself send a health-check ping. The
    // evaluation happens once per frame in the loop below.
    link: readLinkHealth(),
    gpu: gpuName(),
    gpuState: scene.gpuState(),
    framebuffer: scene.size,
  }))

  // The picture cannot survive a context loss, so the first frame after
  // one must not wait out the 1 Hz static floor — that is up to a
  // second of blank projector after the GPU has already come back.
  // Only the restore edge needs this: while the context is *lost* the
  // loop below declines to draw at all, which is what keeps `dirty`
  // set across the outage rather than being cleared by a frame that
  // never reached the glass.
  scene.onGpuStateChange(state => {
    if (state === 'restored') dirty = true
  })

  if (isDesktop()) {
    // F11 as the escape hatch (§3.6 mechanism 4). An output is spawned
    // fullscreen and decorationless, which is right for a capture
    // surface and leaves an operator during calibration with a window
    // they cannot grab, move or close — so `initial: true`, because a
    // controller that assumed windowed would make the first press a
    // no-op. Nothing is persisted: an output has no fullscreen
    // *preference*, it is fullscreen by construction, and a title bar
    // borrowed for a minute must not come back on the next launch.
    createFullscreenController({ host: resolveChromeHost(), initial: true })

    try {
      const link = await connectOutputLink(await createTauriLinkHost())
      readLinkHealth = () => link.linkHealth()
      readCalibration = () => link.renderConfig().calibration

      // The manager cannot find this out any other way (rung 13, case
      // 5). Its other detectors all read an *absence* — a destroy with
      // no `output_closing`, a window that never answers a poke — and
      // a GPU loss defeats every one of them: this window stays up, the
      // channel stays healthy, the heartbeat keeps being answered, and
      // the sphere is black. Subscribed after the link exists rather
      // than beside the dirty-flag subscription above, because a
      // report before there is anywhere to send it is not a report;
      // the current state is pushed once immediately for the same
      // reason `link.renderConfig()` is read once — a context lost
      // during boot, which on a crowded machine is exactly when
      // eviction happens, would otherwise never be mentioned.
      //
      // **The initial push replays the incident, not just its
      // outcome**, and that is a fix rather than a flourish. The gap
      // between the scene being built and the link attaching is
      // awaited twice (`createTauriLinkHost`, then
      // `connectOutputLink`), so a loss *and* its restore can both land
      // inside it — and reporting only `restored` then tells the
      // manager a context came back that it never heard leave. It
      // latches nothing and the incident is never counted. `restored`
      // implies a loss happened, so saying both is the honest replay.
      // Found in review.
      const initial = scene.gpuState()
      if (initial === 'restored') link.reportGpuState('lost')
      link.reportGpuState(initial)

      // A poke comes only from a manager that booted after a control
      // window reload, so it has heard nothing this window ever said —
      // and GPU state travels on edges with no heartbeat to re-state
      // it, unlike `view` or `dataset`. Without this an output sitting
      // in `lost` is adopted with `gpuLost: false` and no badge, which
      // is precisely the invisible failure the badge exists for.
      //
      // The *current* state alone, never the replay above: the fresh
      // manager needs this window's standing condition, while the
      // incident itself was already reported to — and counted by — the
      // manager that saw it happen.
      link.onReannounce(() => link.reportGpuState(scene.gpuState()))

      scene.onGpuStateChange(state => link.reportGpuState(state))

      /**
       * Rebuild the composite from whatever the mirror currently holds.
       *
       * The dataset is slot 0 and the mirrored layers follow, because
       * array order *is* z-order in the one fragment shader that draws
       * them. It reads the *mirror*, not the link: the link's `dataset`
       * is what the control window says, and the mirror's is what this
       * window has actually decoded. Compositing the former would put
       * an incoming dataset's bbox and palette over the outgoing
       * dataset's pixels for the length of a load.
       */
      // The pattern's whole lifecycle — when it is rebuilt, when a
      // failure is retried, why it is not thrown away when calibration
      // goes off — lives in `calibrationPattern.ts`, where it is
      // testable. What is left here is the substitution.
      const calibrationCache = createCalibrationCache()
      const calibrationLayer = (): OutputLayerInput | null => {
        const canvas = calibrationCache.canvasFor(link.renderConfig().framebufferWidth)
        return canvas ? { kind: 'image', element: canvas, overlay: CALIBRATION_OVERLAY } : null
      }

      const recomposite = (): void => {
        const state = link.state()
        const media = mirror.current()
        const primary = mirror.currentDataset()
        const layers: OutputLayerInput[] = []
        // Instead of the mirrored dataset, never over it. A graticule
        // composited on top of data leaves neither legible, and what is
        // being checked here is geometry — so the pattern wants the
        // sphere to itself. The mirror is untouched underneath: the
        // decoder keeps running and keeps being steered, so turning
        // calibration off puts the dataset back in step rather than
        // reloading it.
        const pattern = link.renderConfig().calibration ? calibrationLayer() : null
        if (pattern) {
          layers.push(pattern)
        } else if (media && primary) {
          layers.push({
            kind: media.kind,
            element: media.element,
            overlay: primary.overlay,
            // The operator's palette / stretch / threshold acts on the
            // primary alone; a stacked layer keeps its own.
            display: state.display,
          })
        }
        scene.setLayers(layers)
      }

      const applyState = (
        changed: readonly StateKey[],
        state: Readonly<OutputGlobeState>,
      ): void => {
        // Only on a real dataset change: `datasetMirror` decides
        // whether that means a reload or just new metadata, since an
        // overlay-only change must not restart the decoder.
        if (changed.includes('dataset')) {
          void mirror.apply(state.dataset).then(recomposite)
        } else if (changed.includes('display')) {
          // A palette change costs a LUT upload, not a reload — the
          // decoder never sees it.
          recomposite()
        }
        if (changed.includes('view')) {
          scene.setParams(state.view.params)
          // Geometry and illumination arrive on the same key but
          // are different questions: `params` is where the camera
          // is looking, `dayNight` is whether the Earth is lit.
          scene.setDayNight(state.view.dayNight)
        }
        // Anything that changed the *picture* is worth a frame —
        // including the keys this loop does not yet composite, so the
        // 1 Hz floor never holds a change back once they are wired.
        // `playback` and `primary` are not among them: they say where
        // the control window's playhead is, they arrive on every frame
        // the operator's globe plays, and nothing here draws from them.
        // This output's own frame advance is paced by `contentKindFor`
        // and its seeks are caught below by comparing `currentTime`
        // across the steer, so drawing on the diff as well was double
        // the GPU for an identical picture.
        if (changesPicture(changed)) dirty = true
      }
      link.onChange(applyState)
      // The same race the render config below handles, and a worse
      // outcome. `connectOutputLink` installs its own IPC listener
      // before emitting `output_ready`, so the manager's first snapshot
      // can be folded into the link's store while it is still awaiting
      // that emit — before this listener exists. Nothing would replay
      // it: the idle heartbeat sends a *full* snapshot every second,
      // but the store compares against what it already holds, so an
      // identical one reports no changed keys and never fires. The
      // output would sit on the idle Earth with a dataset already
      // loaded on the control window, until the operator happened to
      // change something. `STATE_KEYS` rather than a hand-written list
      // so a key added to the schema is applied here too.
      applyState(STATE_KEYS, link.state())

      /**
       * Window configuration, which travels on its own channel.
       *
       * Applied idempotently, because both callers can deliver the same
       * value: `setFramebufferWidth` no-ops on an unchanged snapped
       * size, and `setVisible` on an unchanged flag costs one repaint.
       */
      const applyConfig = (config: OutputRenderConfig): void => {
        scene.setFramebufferWidth(config.framebufferWidth)
        overlay.setVisible(config.debugOverlay)
        // After the width is applied, not before: `calibrationLayer()`
        // reads the config's width to decide whether its cached canvas
        // is still the right size, and a pattern rebuilt against the
        // old rung would be replaced again on the very next
        // recomposite. Unconditional because this runs only on an
        // operator action, and `setLayers` no-ops on an identical
        // element — so a config change that touched neither the width
        // nor the toggle costs one array build.
        recomposite()
        dirty = true
      }
      link.onRenderConfig(applyConfig)
      // Not merely defensive: the manager answers `output_ready` with a
      // config, and that reply can land while `connectOutputLink` is
      // still awaiting its own emit — before this listener exists. The
      // link holds what arrived, so reading it once here is what stops a
      // config being silently dropped in that window.
      applyConfig(link.renderConfig())

      // Steered here rather than inside the listener: see the header.
      const steer = (): void => {
        const state = link.state()
        const before = mirror.current()?.video?.currentTime
        lastSync = mirror.sync({
          dataset: state.dataset,
          primary: state.primary,
          playback: state.playback,
        })
        // A seek changes the decoded frame without the scene knowing.
        if (before !== mirror.current()?.video?.currentTime) dirty = true
        // Rides this loop rather than starting a timer (rung 13, case
        // 3). The loop runs every frame and the loop's *draw* floors at
        // 1 Hz, either of which is ample against a five-second
        // threshold — and the watchdog rations its own pings, so
        // calling it at the frame rate costs an integer compare.
        // Deliberately **not** flagging the scene dirty on a health
        // transition: the picture does not change when the link does,
        // and a stale link that forced a redraw would spend GPU
        // announcing that nothing is arriving.
        link.checkHealth()
      }
      steerers.push(steer)
    } catch (err) {
      // Costs the link, not the window. The operator sees a correct
      // idle Earth, and the control window's Outputs panel is where
      // the missing output is reported (rung 13's health badges).
      logger.error('[Output] could not attach to the control window:', err)
    }
  }

  const tick = (now: number): void => {
    // First thing in the callback, and before any early return could be
    // added below it: this counts callbacks, not work done in them.
    rafMeter.tick(now)
    // Zero on the very first callback, which reduces the gate to the
    // plain `>=` it used to be for exactly one tick — harmless, since
    // that tick draws on `dirty` anyway.
    const sinceLastCallbackMs = lastCallback === null ? 0 : now - lastCallback
    lastCallback = now
    for (const steer of steerers) steer()
    // The scene reports its own changes — today, the CDN texture
    // upgrading 2K → 4K → 8K after first paint. Without this the
    // upgrade waits out the 1 Hz static floor and pops on a projector.
    dirty = scene.consumeDirty() || dirty
    // Recomputed every frame rather than latched on a dataset change:
    // whether the element is advancing is what sets the pace, and that
    // changes when the operator pauses without any state key changing
    // shape. See `contentKindFor`.
    const kind = contentKindFor(mirror.current())
    // A lost context draws nothing — Three's renderer returns from
    // `render()` immediately once it has seen `webglcontextlost`. The
    // call is therefore harmless and the *bookkeeping after it* is not:
    // ticking the fps meter, clearing `dirty` and advancing the frame
    // deadline for a frame that reached no pixels makes the HUD report
    // a healthy 30 fps over a black projector, which is the precise
    // shape of invisible failure this whole rung exists to remove. So
    // the frame is skipped rather than drawn-and-counted: fps falls to
    // 0 on the next sample, `dirty` survives the outage, and the
    // restore above paints immediately.
    if (
      scene.gpuState() !== 'lost' &&
      shouldRenderFrame({ kind, nowMs: now, dueMs, sinceLastCallbackMs, dirty })
    ) {
      // Timed here rather than inside the scene: the scene has no HUD
      // and no reason to learn about one, and this is the only place
      // that knows a frame was actually drawn. `performance.now()`
      // rather than the rAF timestamp, which is the frame's *start* and
      // would measure the whole callback.
      const drawStart = performance.now()
      scene.render()
      drawTimer.record(performance.now() - drawStart)
      // Counted on drawn frames, not on rAF callbacks: the question the
      // HUD answers is whether this output is painting, and for static
      // content the honest answer is the 1 Hz floor rather than the
      // display's refresh rate.
      fpsMeter.tick(now)
      dueMs = advanceFrameDeadline(dueMs, now, kind)
      dirty = false
    }
    // Sampled from the rAF loop rather than from the HUD's reader, so
    // the window stays ~500 ms even while the output is drawing at 1 Hz
    // — and so the reader stays pure, since `sample()` resets the
    // window and a hidden HUD would otherwise hand its first reading an
    // average over however long it was hidden.
    if (now - lastFpsSample >= OVERLAY_REFRESH_MS) {
      fps = fpsMeter.sample(now)
      rafHz = rafMeter.sample(now)
      drawMs = drawTimer.sample()
      lastFpsSample = now
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

void boot()
