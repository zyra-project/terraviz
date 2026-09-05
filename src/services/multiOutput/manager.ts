// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `MultiOutputManager` — the control window's side of the multi-monitor
 * output feature (`docs/MULTI_MONITOR_PLAN.md` §3).
 *
 * It enumerates monitors, spawns and tears down `output-*` windows,
 * and is the single source of truth every output mirrors: state goes in
 * through `applyState`, out through `StateAggregator`, and onto the
 * wire one `emitTo` per live output. Outputs never ask for state on
 * their own initiative after `output_ready`.
 *
 * ## The Tauri surface is a seam, and the ordering is not
 *
 * Everything platform-specific goes through `MultiOutputHost`, and
 * `createTauriHost()` is the only implementation that imports Tauri.
 * That is not decoration: the one part of this module a spike actually
 * caught a bug in — the spawn sequence — is arithmetic and ordering,
 * and putting it behind a seam is what makes it testable on a
 * one-monitor CI runner with no Tauri at all.
 *
 * The sequence is spawn-hidden → position → size → fullscreen → show,
 * and each step is there for a reason the plan's "Monitor geometry and
 * placement" records:
 *
 * - **Hidden first.** `fullscreen: true` at construction fullscreens
 *   onto whichever monitor the window happened to land on, and a
 *   visible window sliding across the desk is an artifact on a capture
 *   feed at exactly the moment an installation is being set up.
 * - **Physical, unconverted.** `WindowOptions.x/y/width/height` are
 *   *logical* pixels; `availableMonitors()` reports *physical* ones.
 *   Only `setPosition`/`setSize` take physical values, so the placement
 *   cannot be one call. Passing the monitor's own numbers through
 *   unconverted means there is no `scaleFactor` arithmetic to get wrong
 *   — which matters because a mixed-DPI desk puts the window on the
 *   wrong monitor and reads as "the feature is broken" rather than as a
 *   units bug.
 * - **Signed origins.** The spike's `\\.\DISPLAY1` sat at `x = −1680`.
 *   Nothing here may assume a non-negative origin.
 * - **`show()` last**, which is why §6 grants `core:window:allow-show`:
 *   `visible: false` is a free constructor option, but bringing the
 *   window back is a command and `core:window:default` is getters only.
 *
 * ## What is deliberately not here yet
 *
 * Persistence (commit 10), the Outputs panel (commit 9), and the whole
 * of failure recovery — crash detection, the monitor-unplug poll, the
 * orphan boot scan, health badges (commit 13). `handleOutputEvent`
 * therefore records what an output reports and does not yet act on it;
 * the events are part of the protocol from commit 1, and dropping them
 * on the floor until commit 13 would mean commit 13 has to re-derive
 * which ones arrive.
 */

import {
  OUTPUT_EVENT,
  OUTPUT_STATE_EVENT,
  STATE_TICK_MS,
  isOutputLabel,
  outputLabel,
  type MirroredGlobeState,
  type OutputEvent,
  type OutputMode,
  type OutputStateMessage,
} from './protocol'
import {
  DEFAULT_VIEW_SETTINGS,
  StateAggregator,
  projectState,
  type OutputViewSettings,
} from './stateAggregator'
import { logger } from '../../utils/logger'

/** Where the output bundle lands in the build. `vite.config.ts` roots
 *  at `src/`, so `src/output/output.html` becomes this. */
export const OUTPUT_ENTRY_URL = 'output/output.html'

// --- The platform seam ---

/**
 * One monitor, in the shape `availableMonitors()` reports it.
 *
 * `position` and `size` are **physical** pixels and `position` is
 * **signed** — see the module header.
 */
export interface OutputMonitor {
  name: string | null
  position: { x: number; y: number }
  size: { width: number; height: number }
  scaleFactor: number
}

/** The handle the manager drives an output window through. Physical
 *  units throughout, matching `PhysicalPosition` / `PhysicalSize`. */
export interface OutputWindowHandle {
  setPosition(x: number, y: number): Promise<void>
  setSize(width: number, height: number): Promise<void>
  setFullscreen(fullscreen: boolean): Promise<void>
  show(): Promise<void>
  close(): Promise<void>
}

/** Everything the manager needs from the host platform. */
export interface MultiOutputHost {
  availableMonitors(): Promise<OutputMonitor[]>
  /** Create the window **hidden and undecorated**, navigated to `url`.
   *  Placement is the manager's job, not the constructor's. */
  createWindow(label: string, url: string): Promise<OutputWindowHandle>
  emitTo(label: string, event: string, payload: unknown): Promise<void>
  /** Subscribe to an event; resolves to the unlisten function. */
  listen(event: string, handler: (payload: unknown) => void): Promise<() => void>
}

// --- Output records ---

/** What the operator chose when adding an output. */
export interface AddOutputOptions {
  /** Index into the array `listMonitors()` returned. */
  monitorIndex: number
  mode?: OutputMode
  view?: Partial<OutputViewSettings>
}

/** The manager's record of one live output. */
export interface OutputRecord {
  label: string
  mode: OutputMode
  view: OutputViewSettings
  /** The monitor it was placed on, captured at spawn. Commit 10 matches
   *  this against `availableMonitors()` on restore, on **both** name and
   *  signed origin — a Windows display name alone is positional and
   *  reassignable. */
  monitor: OutputMonitor
  /** True once the output has emitted `output_ready` and been sent its
   *  first full snapshot. Diffs go only to ready outputs; one that is
   *  still booting would apply a diff against a state it never had. */
  ready: boolean
  /** The last event this output reported, for commit 13's health
   *  badges. Recorded, not yet acted on. */
  lastEvent: OutputEvent | null
}

export class MultiOutputManager {
  private readonly host: MultiOutputHost
  private readonly aggregator = new StateAggregator()
  private readonly records = new Map<string, OutputRecord>()
  private readonly handles = new Map<string, OutputWindowHandle>()

  private unlisten: (() => void) | null = null
  /**
   * Set **synchronously** by `start()`, before it awaits.
   *
   * `unlisten` alone cannot guard re-entry: it is only assigned once
   * `host.listen` resolves, so two concurrent `start()` calls both see
   * `null`, both subscribe, and `stop()` then unlistens one of them and
   * leaves the other delivering into a manager that believes it stopped.
   */
  private starting = false
  private timer: ReturnType<typeof setInterval> | null = null
  private nextIndex = 1

  constructor(host: MultiOutputHost) {
    this.host = host
  }

  /**
   * Begin listening for output events and start the broadcast tick.
   *
   * Cheap and idempotent, but not free — it opens an IPC listener — so
   * boot does not call it. The plan's boot flow step 1 is explicit that
   * an install which has never enabled outputs pays nothing: no monitor
   * enumeration, no IPC.
   */
  async start(): Promise<void> {
    if (this.starting || this.unlisten) return
    this.starting = true
    try {
      const unlisten = await this.host.listen(OUTPUT_EVENT, payload => {
        this.handleOutputEvent(payload)
      })
      // `stop()` may have run while the subscribe was in flight. Honour
      // it rather than installing a listener nobody asked for.
      if (!this.starting) {
        unlisten()
        return
      }
      this.unlisten = unlisten
      this.timer ??= setInterval(() => void this.tick(), STATE_TICK_MS)
    } finally {
      this.starting = false
    }
  }

  /** Stop listening and stop ticking. Does **not** close outputs: an
   *  output that keeps showing its last known state is the correct
   *  behaviour for an audience mid-session (see the protocol's
   *  `IPC_ORPHAN_MS`). Use `closeAll()` to tear them down. */
  stop(): void {
    // Clearing this cancels a `start()` still awaiting its subscribe.
    this.starting = false
    this.unlisten?.()
    this.unlisten = null
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  listMonitors(): Promise<OutputMonitor[]> {
    return this.host.availableMonitors()
  }

  outputs(): OutputRecord[] {
    return [...this.records.values()]
  }

  /**
   * Spawn an output on one monitor.
   *
   * Resolves once the window is placed and shown — not once it is
   * rendering. The output announces that itself with `output_ready`,
   * which is when it gets its first state.
   */
  async addOutput(options: AddOutputOptions): Promise<OutputRecord> {
    const monitors = await this.host.availableMonitors()
    const monitor = monitors[options.monitorIndex]
    if (!monitor) {
      throw new Error(
        `no monitor at index ${options.monitorIndex} (${monitors.length} available)`,
      )
    }

    const label = outputLabel(this.nextIndex++)
    const handle = await this.host.createWindow(label, OUTPUT_ENTRY_URL)

    try {
      // Order is load-bearing — see the module header.
      await handle.setPosition(monitor.position.x, monitor.position.y)
      await handle.setSize(monitor.size.width, monitor.size.height)
      await handle.setFullscreen(true)
      await handle.show()
    } catch (err) {
      // The window already exists but never reached `records`/`handles`,
      // so nothing else can ever reach it — `closeAll()` included. On an
      // installation that is a hidden, undecorated window the operator
      // cannot get rid of without killing the app. Close it here, then
      // let the caller see the original failure.
      try {
        await handle.close()
      } catch (closeErr) {
        logger.warn(`[multiOutput] could not close half-spawned ${label}:`, closeErr)
      }
      throw err
    }

    const record: OutputRecord = {
      label,
      mode: options.mode ?? 'sos-equirect',
      // Spread-with-`undefined` would let `{ trackCamera: undefined }`
      // overwrite the default with `undefined` — the same hazard
      // `foldKey` guards against in the aggregator, and it would pin the
      // output to a centred camera for no stated reason.
      view: { ...DEFAULT_VIEW_SETTINGS, ...definedOnly(options.view) },
      monitor,
      ready: false,
      lastEvent: null,
    }
    this.records.set(label, record)
    this.handles.set(label, handle)
    return record
  }

  /** Close one output and drop its record. Safe to call for a label
   *  that is already gone — the operator closing a window by hand and
   *  the panel's remove button race, and neither should throw. */
  async removeOutput(label: string): Promise<void> {
    const handle = this.handles.get(label)
    if (handle) {
      // Close *before* forgetting it. A rejection is absorbed rather
      // than propagated: the manager has no retry to offer until commit
      // 13, and letting it escape would reject the whole of
      // `closeAll()`, so one stuck window would strand every other.
      try {
        await handle.close()
      } catch (err) {
        logger.warn(`[multiOutput] close failed for ${label}, dropping record anyway:`, err)
      }
    }
    this.handles.delete(label)
    this.records.delete(label)
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.records.keys()].map(l => this.removeOutput(l)))
  }

  /**
   * Change one output's own view settings.
   *
   * Sends that output a fresh view immediately rather than waiting for
   * the next shared change: toggling "Track operator camera" with a
   * static globe on screen would otherwise appear to do nothing until
   * someone happened to pan.
   */
  async setOutputView(
    label: string,
    view: Partial<OutputViewSettings>,
  ): Promise<void> {
    const record = this.records.get(label)
    if (!record) return
    record.view = { ...record.view, ...view }
    if (!record.ready) return
    const { view: shared } = this.aggregator.current()
    // `bump()`, not `sequence()`: this is a new event for this output,
    // and re-using the number it has already applied loses to it under
    // most-recent-wins coalescing — which would make the toggle look
    // inert, the exact failure this method exists to prevent.
    await this.emit(record, {
      seq: this.aggregator.bump(),
      full: false,
      state: projectState({ view: shared }, record.view),
    })
  }

  /**
   * Fold a state change in and broadcast the diff.
   *
   * The single entry point for everything the control window knows —
   * dataset loads, layer edits, playback, palette, camera. Rung 7 gave
   * `main.ts` the events, and rung 8's `bootMultiOutput` subscribes them
   * to this method; today only `dataset` is actually published, so the
   * other keys still arrive from nowhere.
   */
  async applyState(patch: Partial<MirroredGlobeState>): Promise<void> {
    const message = this.aggregator.apply(patch)
    if (!message) return
    await this.broadcast(message)
  }

  /** Send one message to every ready output, projected through that
   *  output's own view settings. */
  private async broadcast(message: OutputStateMessage): Promise<void> {
    await Promise.all(
      this.readyRecords().map(record =>
        this.emit(record, {
          ...message,
          state: projectState(message.state, record.view),
        }),
      ),
    )
  }

  /**
   * The per-second timecode tick.
   *
   * This is a **heartbeat**, not a change notification, and the
   * distinction is load-bearing. `protocol.ts` defines `IPC_STALE_MS`
   * (5 s) as the silence after which an output declares the link stale
   * and the Outputs panel badges it — measured against this
   * `STATE_TICK_MS` cadence. So the tick must put something on the wire
   * every second whether or not anything changed. It once called
   * `applyState({})`, which can never produce a diff, so the cadence
   * the staleness detector measures against did not exist at all and
   * any paused or static globe would have gone stale after five
   * seconds.
   *
   * When there *is* no change the heartbeat carries a full snapshot
   * rather than an empty ping. It costs the same round trip, and it
   * makes the link self-healing: an output that missed a diff — a
   * dropped message, a reload, a webview the OS suspended — is
   * resynced within a second instead of holding a wrong frame until
   * the next unrelated change. A second message shape would buy
   * nothing and would be one more thing for the output to handle.
   */
  async tick(): Promise<void> {
    const message = this.aggregator.apply({})
    if (message) {
      await this.broadcast(message)
      return
    }
    const snapshot = this.aggregator.full()
    await Promise.all(
      this.readyRecords().map(record =>
        this.emit(record, {
          ...snapshot,
          state: projectState(snapshot.state, record.view),
        }),
      ),
    )
  }

  /** The current shared state, for the panel's debug readout. */
  currentState(): Readonly<MirroredGlobeState> {
    return this.aggregator.current()
  }

  // --- Internals ---

  private readyRecords(): OutputRecord[] {
    return [...this.records.values()].filter(r => r.ready)
  }

  /**
   * Send one message to one output, absorbing a transport failure.
   *
   * A rejection here means the window went away between the record
   * being live and the emit landing — the operator closed it, or it
   * crashed. Letting that propagate would take down the whole
   * `Promise.all` in `applyState`, so one dead output would stop every
   * healthy one from being updated. Commit 13 is what *notices* the
   * dead output; this only makes sure the others keep rendering in the
   * meantime.
   */
  private async emit(record: OutputRecord, payload: unknown): Promise<void> {
    try {
      await this.host.emitTo(record.label, OUTPUT_STATE_EVENT, payload)
    } catch (err) {
      logger.warn(`[multiOutput] state emit to ${record.label} failed:`, err)
    }
  }

  /**
   * Route one `output_event` payload to its record.
   *
   * Validates rather than trusts. The payload arrives over an IPC
   * channel every output can emit on, so an event without a `label`
   * that names a live output is unattributable and is dropped — which
   * is the protocol's own rule for the field.
   */
  private handleOutputEvent(payload: unknown): void {
    const event = asOutputEvent(payload)
    if (!event) return
    const record = this.records.get(event.label)
    if (!record) return

    record.lastEvent = event
    if (event.type === 'output_ready') {
      record.ready = true
      const snapshot = this.aggregator.full()
      void this.emit(record, {
        ...snapshot,
        state: projectState(snapshot.state, record.view),
      })
    } else if (event.type === 'output_closing') {
      record.ready = false
    }
  }
}

/**
 * Drop keys whose value is `undefined`, so a spread cannot overwrite a
 * default with nothing.
 *
 * `{ ...DEFAULTS, ...partial }` treats an explicitly-`undefined` field
 * as a value and clobbers the default with it — which is how a caller
 * spreading an optional field ends up pinning an output's camera off
 * without ever having said so.
 */
function definedOnly<T extends object>(partial: T | undefined): Partial<T> {
  if (!partial) return {}
  const out: Partial<T> = {}
  for (const [k, v] of Object.entries(partial)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v
  }
  return out
}

/** Narrow an IPC payload to an `OutputEvent`, or `null`. */
function asOutputEvent(payload: unknown): OutputEvent | null {
  if (!payload || typeof payload !== 'object') return null
  const candidate = payload as Partial<OutputEvent>
  if (typeof candidate.type !== 'string') return null
  if (typeof candidate.label !== 'string' || !isOutputLabel(candidate.label)) {
    return null
  }
  return candidate as OutputEvent
}

/**
 * The Tauri implementation of `MultiOutputHost`.
 *
 * Lazy-imported behind the caller's own desktop check, the same pattern
 * `llmProvider` and `downloadService` use, so the web bundle never
 * pulls Tauri in. Deliberately thin: it converts units and shapes and
 * does nothing else, because anything with a decision in it belongs on
 * the testable side of the seam.
 */
export async function createTauriHost(): Promise<MultiOutputHost> {
  const [{ WebviewWindow }, windowApi, eventApi] = await Promise.all([
    import('@tauri-apps/api/webviewWindow'),
    import('@tauri-apps/api/window'),
    import('@tauri-apps/api/event'),
  ])
  const { PhysicalPosition, PhysicalSize, availableMonitors } = windowApi

  return {
    async availableMonitors() {
      const monitors = await availableMonitors()
      return monitors.map(m => ({
        name: m.name,
        position: { x: m.position.x, y: m.position.y },
        size: { width: m.size.width, height: m.size.height },
        scaleFactor: m.scaleFactor,
      }))
    },

    async createWindow(label, url) {
      const win = new WebviewWindow(label, {
        url,
        // Both are why the sequence in this module exists: no
        // `fullscreen` and no position here, because neither can be
        // expressed in physical pixels at construction.
        visible: false,
        decorations: false,
        title: label,
      })
      await new Promise<void>((resolve, reject) => {
        void win.once('tauri://created', () => resolve())
        void win.once('tauri://error', e => reject(new Error(String(e.payload))))
      })
      return {
        setPosition: (x, y) => win.setPosition(new PhysicalPosition(x, y)),
        setSize: (w, h) => win.setSize(new PhysicalSize(w, h)),
        setFullscreen: on => win.setFullscreen(on),
        show: () => win.show(),
        close: () => win.close(),
      }
    },

    emitTo: (label, event, payload) => eventApi.emitTo(label, event, payload),

    listen: (event, handler) =>
      eventApi.listen(event, e => handler(e.payload)),
  }
}
