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
  FRAMEBUFFER_WIDTHS,
  OUTPUT_EVENT,
  OUTPUT_RENDER_CONFIG_EVENT,
  OUTPUT_STATE_EVENT,
  STATE_TICK_MS,
  defaultRenderConfig,
  isOutputLabel,
  outputLabel,
  outputLabelIndex,
  type MirroredGlobeState,
  type OutputEvent,
  type OutputMode,
  type OutputRenderConfig,
  type OutputStateMessage,
  type SharedStateMessage,
} from './protocol'
import {
  DEFAULT_VIEW_SETTINGS,
  StateAggregator,
  projectState,
  type OutputViewSettings,
} from './stateAggregator'
import {
  OUTPUT_RESTORE_STAGGER_MS,
  createOutputConfigStore,
  matchMonitorIndex,
  parseDecoderBudget,
  renderConfigFrom,
  toPersistedOutput,
  type OutputConfigStore,
} from './outputPersistence'
import {
  classifyDeparture,
  createCrashStormGuard,
  monitorKeyOf,
  type CrashStormGuard,
  type OutputDeparture,
} from './outputHealth'
import {
  removalReasonFor,
  reportOutputAdded,
  reportOutputFailure,
  reportOutputRemoved,
} from './outputTelemetry'
import { maxVideoPanels } from '../../utils/deviceCapability'
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
  /**
   * Called once when the OS destroys this window, however that came
   * about — the manager's own `close()`, the operator's Alt+F4, or the
   * process dying (rung 13, `outputHealth.classifyDeparture`).
   *
   * Required rather than optional, which is the choice worth stating:
   * a host that could not report a destroy would leave the manager
   * broadcasting to a window that no longer exists and holding its
   * decoder slot forever, and an optional method is how that ends up
   * quietly unimplemented on some platform. A host with nothing to
   * subscribe to should say so by never calling back, not by omitting
   * the method.
   */
  onDestroyed(handler: () => void): Promise<void>
}

/** Everything the manager needs from the host platform. */
export interface MultiOutputHost {
  availableMonitors(): Promise<OutputMonitor[]>
  /**
   * The display the platform calls primary, or `null` when it will not
   * say.
   *
   * A separate call because `availableMonitors()` does not carry the
   * flag, and **asked rather than inferred** because the obvious
   * inference is wrong often enough to matter: the primary is at the
   * origin on Windows by definition, usually at the origin on macOS,
   * and on X11 is whatever `xrandr --primary` marks — which can sit
   * anywhere. A guess that is usually right and silently wrong is the
   * same failure the name-only monitor match was rejected for. `null`
   * is a real answer, and the panel simply marks nothing.
   */
  primaryMonitor(): Promise<OutputMonitor | null>
  /** Create the window **hidden and undecorated**, navigated to `url`.
   *  Placement is the manager's job, not the constructor's. */
  createWindow(label: string, url: string): Promise<OutputWindowHandle>
  emitTo(label: string, event: string, payload: unknown): Promise<void>
  /** Subscribe to an event; resolves to the unlisten function. */
  listen(event: string, handler: (payload: unknown) => void): Promise<() => void>
}

// --- Output records ---

/** Injectable collaborators. Both default to the real thing; tests
 *  override them so persistence needs no browser and the restore
 *  stagger costs no wall-clock. */
export interface MultiOutputDeps {
  store?: OutputConfigStore
  sleep?: (ms: number) => Promise<void>
  /**
   * How many panels the **control window** is holding.
   *
   * Injected rather than read, because the manager has no business
   * knowing what a viewport is and `viewportManager` has no business
   * knowing what an output is. `main.ts` owns both and wires them
   * together through `bootMultiOutput`.
   *
   * Defaults to 1 — the layout an app opens on — so a manager
   * constructed without it still counts the control window rather than
   * pretending the machine is empty.
   */
  controlPanels?: () => number
  /**
   * What this machine reports it can hold, for an unset budget.
   *
   * `maxVideoPanels()` by default. Injected so the manager stays free
   * of `window`, and so a test can state the machine's answer instead
   * of depending on the test environment's viewport size.
   */
  machineDecoderBudget?: () => number
}

/** What the operator chose when adding an output. */
export interface AddOutputOptions {
  /** Index into the array `listMonitors()` returned. */
  monitorIndex: number
  mode?: OutputMode
  view?: Partial<OutputViewSettings>
  render?: Partial<OutputRenderConfig>
}

/** The manager's record of one live output. */
export interface OutputRecord {
  label: string
  mode: OutputMode
  view: OutputViewSettings
  /**
   * This window's render settings — framebuffer resolution and debug
   * HUD (rung 11).
   *
   * Held beside `view` rather than folded into it because they travel
   * on a different channel and for a different reason: `view` is a
   * projection of globe state and is diffed against a sequence, while
   * this is window configuration that changes only when the operator
   * changes it. Putting them together would mean either sequencing a
   * checkbox or un-sequencing the camera.
   */
  render: OutputRenderConfig
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
  /**
   * The manager is closing this one and expects the destroy that
   * follows (rung 13).
   *
   * Set before `close()` rather than after, because the destroy
   * callback can land while the close is still being awaited — and a
   * departure classified in that window would read as a crash.
   */
  departing: boolean
  /** This output emitted `output_closing` — it is going away and said
   *  so, which is what separates an operator's Alt+F4 from a crash. */
  announcedClosing: boolean
}

export class MultiOutputManager {
  private readonly host: MultiOutputHost
  private readonly aggregator = new StateAggregator()
  private readonly records = new Map<string, OutputRecord>()
  private readonly handles = new Map<string, OutputWindowHandle>()
  private readonly crashStorm: CrashStormGuard = createCrashStormGuard()
  /** Notified whenever the set of live outputs changes underneath the
   *  operator — today only a departure the manager did not ask for. */
  private readonly changeListeners = new Set<() => void>()

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

  /**
   * The persisted configuration.
   *
   * The manager owns this because it owns `records`, which is exactly
   * what gets persisted. Any other owner would have to be told when a
   * record changes, and every call site that forgot would be a config
   * that silently stopped tracking reality.
   */
  private readonly store: OutputConfigStore
  /** Injectable so the restore stagger is testable without spending it. */
  private readonly sleep: (ms: number) => Promise<void>
  private readonly controlPanels: () => number
  private readonly machineDecoderBudget: () => number

  constructor(host: MultiOutputHost, deps: MultiOutputDeps = {}) {
    this.host = host
    this.store = deps.store ?? createOutputConfigStore()
    this.sleep =
      deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
    this.controlPanels = deps.controlPanels ?? (() => 1)
    this.machineDecoderBudget = deps.machineDecoderBudget ?? maxVideoPanels
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

  /**
   * Which of those the platform calls primary, or `null`.
   *
   * Passed straight through rather than folded into `listMonitors()`,
   * because `OutputMonitor` is **persisted** on every `OutputRecord`:
   * a field added to it is a field written into an operator's stored
   * config, where a stale "this one was primary last launch" is worse
   * than no answer at all. The panel asks for both and joins them on
   * `monitorKey`.
   */
  primaryMonitor(): Promise<OutputMonitor | null> {
    return this.host.primaryMonitor()
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

    const record = await this.spawn(
      outputLabel(this.nextIndex++),
      monitor,
      options.monitorIndex,
      options.mode ?? 'sos-equirect',
      { ...DEFAULT_VIEW_SETTINGS, ...definedOnly(options.view) },
      { ...defaultRenderConfig(), ...definedOnly(options.render) },
    )
    this.persist()
    return record
  }

  /**
   * Create, place, reveal and record one output window.
   *
   * Shared by `addOutput` and `restoreOutputs` so a restored output goes
   * through the exact spawn sequence a fresh one does. Two copies of a
   * sequence whose *order* is the correctness (see the module header)
   * is two places for that order to drift.
   *
   * Takes a `label` rather than minting one, because restore reuses the
   * label an output had last launch: `output-1` then keeps meaning the
   * same display across launches, which is what makes it worth anything
   * in a log or in rung 13's health badges.
   */
  private async spawn(
    label: string,
    monitor: OutputMonitor,
    monitorIndex: number,
    mode: OutputMode,
    view: OutputViewSettings,
    render: OutputRenderConfig,
  ): Promise<OutputRecord> {
    // Before the window, not after: the plan's rule is that the ceiling
    // is on decoders *existing*, and there is no window in which to
    // intervene once one has been asked for.
    //
    // Here rather than in `addOutput` so a restore is held to the same
    // rule — a machine whose budget was lowered, or which now reports
    // less than it did, must not bring back eight windows on launch
    // because they were configured when it could. `restoreOutputs`
    // already treats a throwing spawn as one lost output rather than a
    // lost set, so this needs nothing there.
    //
    // Deliberately *not* reported as an `output_removed`: the decided
    // reason enum has no value for it, and rightly — the panel already
    // shows "N of M in use" and disables Add, so a spent budget is an
    // affordance the operator can see rather than a failure they need
    // told about after the fact.
    const { used, budget } = this.decoderLoad()
    if (used + 1 > budget) {
      throw new Error(
        `decoder budget spent: ${used} of ${budget} in use ` +
          '(close a globe panel or an output, or raise the budget)',
      )
    }

    // Beside the decoder refusal and for the same reason it is here
    // rather than in `addOutput`: a restore has to be held to it too.
    // A monitor that killed three outputs in a minute last session
    // will not have improved by the time the operator relaunches with
    // "Restore outputs on launch" ticked — and bringing the window
    // straight back is how a bad display turns into a boot loop.
    if (this.crashStorm.isBlocked(monitorKeyOf(monitor))) {
      // Reported as a *removal* rather than a failure, which reads odd
      // for a window that never existed and is right for the case that
      // matters: a restore. The config says four outputs and three came
      // back, so from every side but the manager's there is a
      // configured output that stopped running, and the reason is the
      // guard. An interactive Add refused here is the same sentence
      // with a shorter gap in it.
      reportOutputRemoved({ mode, reason: 'rejected-by-storm-guard' })
      throw new Error(
        `monitor ${monitor.name ?? 'unnamed'} is refusing outputs this session ` +
          '(it crashed three of them in a minute; relaunch to reset)',
      )
    }

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
      mode,
      view,
      render,
      monitor,
      ready: false,
      lastEvent: null,
      departing: false,
      announcedClosing: false,
    }
    // After the record, so the callback cannot fire against a label the
    // manager does not yet know. A host that cannot report destroys
    // simply never calls back, and the manager behaves as it did before
    // rung 13 rather than failing to spawn.
    await handle.onDestroyed(() => this.handleDeparture(label))
    this.records.set(label, record)
    this.handles.set(label, handle)
    // Here rather than in `addOutput`, so a restore reports too. The
    // event describes an output existing, not an operator gesture, and
    // an installation that brings four back every launch is exactly
    // the population the Tier A choice was made for.
    reportOutputAdded({ mode, framebufferWidth: render.framebufferWidth, monitorIndex })
    return record
  }

  /** Close one output and drop its record. Safe to call for a label
   *  that is already gone — the operator closing a window by hand and
   *  the panel's remove button race, and neither should throw. */
  async removeOutput(label: string): Promise<void> {
    const handle = this.handles.get(label)
    // Before the close, not after: `onDestroyed` can fire while the
    // close is still being awaited, and a departure read in that window
    // would be classified as a crash — the manager reporting itself.
    const record = this.records.get(label)
    if (record) record.departing = true
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
    // Only for a label that was actually here: this method is
    // documented safe to call twice (the panel's Remove and a hand
    // close race), and a second call must not report a second removal.
    //
    // `closeAll()` funnels through here, so a future shutdown path that
    // calls it would report one `operator-close` per output. Nothing
    // calls it outside tests today; when something does, it wants its
    // own reason rather than this one.
    if (record) reportOutputRemoved({ mode: record.mode, reason: 'operator-close' })
    this.persist()
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
    // Persisted before the ready gate: the setting is the operator's
    // choice whether or not the output has announced itself yet, and a
    // toggle flipped during boot that vanished at relaunch would be a
    // very hard thing to report.
    this.persist()
    if (!record.ready) return
    const { view: shared } = this.aggregator.current()
    // `bump()`, not `sequence()`: this is a new event for this output,
    // and re-using the number it has already applied loses to it under
    // most-recent-wins coalescing — which would make the toggle look
    // inert, the exact failure this method exists to prevent.
    await this.emit(record, {
      seq: this.aggregator.bump(),
      full: false,
      state: projectState({ view: shared }, record.view, record.mode),
    })
  }

  /**
   * Change one output's render settings — resolution, debug HUD.
   *
   * Deliberately shaped like `setOutputView` and deliberately *not*
   * routed through it: this travels on `OUTPUT_RENDER_CONFIG_EVENT`
   * with no `seq`, because a checkbox has no ordering hazard worth a
   * sequence number, and folding it into the state stream would make
   * the aggregator diff a window setting (see `OutputRenderConfig`).
   *
   * Persisted before the ready gate for the same reason the view is:
   * the operator's choice is theirs whether or not the window has
   * announced itself yet, and a setting flipped during boot that
   * vanished at relaunch would be very hard to report.
   */
  async setOutputRenderConfig(
    label: string,
    render: Partial<OutputRenderConfig>,
  ): Promise<void> {
    const record = this.records.get(label)
    if (!record) return
    record.render = { ...record.render, ...definedOnly(render) }
    this.persist()
    if (!record.ready) return
    await this.emit(record, record.render, OUTPUT_RENDER_CONFIG_EVENT)
  }

  /**
   * Recreate the outputs a previous launch left configured.
   *
   * Returns without enumerating a single monitor or opening the IPC
   * link unless the operator opted in *and* there is something to
   * restore — the plan's boot flow step 1, and the reason this is safe
   * to call unconditionally at boot.
   *
   * Every failure is per-output. A monitor that has gone, or one that
   * matches by name alone, is skipped and logged; a window that refuses
   * to spawn is logged and the rest still come up. An installation with
   * three projectors should not lose all three because one was
   * unplugged.
   */
  async restoreOutputs(): Promise<OutputRecord[]> {
    const config = this.store.read()
    if (!config.autoRestoreOnLaunch || config.outputs.length === 0) return []

    // Before the first spawn, for the same reason the panel awaits it
    // there: a restored output emits `output_ready` as it boots, and a
    // listener installed afterwards races the window it is for.
    await this.start()

    const monitors = await this.host.availableMonitors()
    const restored: OutputRecord[] = []
    for (const output of config.outputs) {
      const index = matchMonitorIndex(output, monitors)
      if (index === null) {
        logger.warn(
          `[multiOutput] not restoring ${output.label}: no monitor matches ` +
            `${output.monitorName ?? '(unnamed)'} at ` +
            `${output.monitorOrigin.x},${output.monitorOrigin.y}`,
        )
        continue
      }
      // Paced, not fired together: startup contention is the one cost
      // the spike could actually measure. Only *between* spawns, so a
      // single restored output pays nothing.
      if (restored.length > 0) await this.sleep(OUTPUT_RESTORE_STAGGER_MS)
      try {
        restored.push(
          await this.spawn(
            output.label,
            monitors[index],
            index,
            output.mode,
            { trackCamera: output.trackOperatorCamera, split: output.split },
            renderConfigFrom(output),
          ),
        )
      } catch (err) {
        logger.warn(`[multiOutput] could not restore ${output.label}:`, err)
      }
    }

    // Past every label now in use, so the operator's next Add cannot
    // mint one that collides with a restored window.
    for (const record of restored) {
      const index = outputLabelIndex(record.label)
      if (index !== null) this.nextIndex = Math.max(this.nextIndex, index + 1)
    }
    // Rewrites the file with exactly what came up. An entry that could
    // not be restored is therefore dropped rather than retried forever
    // — the operator re-picks the display, which is also the only way
    // they learn it moved.
    this.persist()
    return restored
  }

  /** Write the current records to the persisted config, preserving the
   *  operator's opt-in flag. */
  private persist(): void {
    const config = this.store.read()
    this.store.write({
      ...config,
      outputs: [...this.records.values()].map(r => toPersistedOutput(r)),
    })
  }

  /** Whether outputs come back on the next launch. */
  isRestoreOnLaunch(): boolean {
    return this.store.read().autoRestoreOnLaunch
  }

  setRestoreOnLaunch(enabled: boolean): void {
    this.store.write({ ...this.store.read(), autoRestoreOnLaunch: enabled })
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
   *  output's own view settings and mode.
   *
   *  Takes a `SharedStateMessage` and emits an `OutputStateMessage`:
   *  this method *is* the boundary between the state the control
   *  window accumulates and the state a window can render, which is
   *  why the two types differ either side of it. */
  private async broadcast(message: SharedStateMessage): Promise<void> {
    await Promise.all(
      this.readyRecords().map(record =>
        this.emit(record, {
          ...message,
          state: projectState(message.state, record.view, record.mode),
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
          state: projectState(snapshot.state, record.view, record.mode),
        }),
      ),
    )
  }

  /**
   * The machine's concurrent-decoder budget and what is spending it
   * (plan §"Cross-window decoder budget").
   *
   * ## Why a *window* counts, not a decoder
   *
   * The plan's table counts "one per output currently showing a video
   * dataset", and image datasets as free. That is true about the
   * present and wrong about the moment that matters. Outputs mirror the
   * primary, so every output flips from free to costing a decoder the
   * instant the operator loads a video — and a dataset load is not a
   * place a refusal can happen: it is deep inside a loader, with no
   * control to disable and nothing for the operator to undo. So an
   * operator could add eight outputs while an image was up, load a
   * video, and take the installation down with the budget never once
   * consulted.
   *
   * Counting spawned windows instead means the refusal lands on **Add
   * Output**, where there is a button to disable and a number to show.
   * The plan's §"What a throwaway spike measured" is explicit that the
   * failure *shape* on desktop hardware is unknown — whether it is a
   * cliff or a gradient was never established — and under that
   * uncertainty the enforcement point has to be the one the operator
   * can still act on. The cost is real and named in the plan: on a
   * machine whose budget really is 4, an operator running 4 globes
   * cannot also add an output. The budget field below is the answer to
   * that, which is exactly why this rung ships it.
   */
  decoderLoad(): { used: number; budget: number } {
    // Every spawned output, not only the ready ones: a window still
    // booting is about to build a decoder, and a budget that ignored it
    // would let a second Add slip through the gap.
    return { used: this.controlPanels() + this.records.size, budget: this.decoderBudget() }
  }

  /**
   * The budget in force — the operator's number, or the machine's.
   *
   * Falling back rather than storing the machine's answer keeps an
   * unset budget tracking reality: a control window resized below the
   * phone threshold, or a build whose thresholds change, is reflected
   * instead of frozen at whatever was true the first time anyone opened
   * the panel.
   */
  decoderBudget(): number {
    return this.store.read().concurrentDecoderBudget ?? this.machineDecoderBudget()
  }

  /**
   * Pin the budget, or clear it back to what the machine reports.
   *
   * Machine-scoped, so it is stored beside the output list rather than
   * on any output: one GPU and one media stack are shared by every
   * window on the box, which is the whole reason `maxVideoPanels()` —
   * which answers per window — cannot see the constraint.
   */
  setDecoderBudget(budget: number | null): void {
    this.store.write({
      ...this.store.read(),
      concurrentDecoderBudget: budget === null ? null : parseDecoderBudget(budget),
    })
  }

  /**
   * The framebuffer rungs the Outputs panel may offer.
   *
   * Exposed as a method because the panel cannot import `protocol.ts`
   * at runtime — it is eagerly loaded by `main.ts`, and every
   * `multiOutput/` import there is type-only so the web entry graph
   * stays clear of the IPC contract. The manager is already loaded by
   * then, so it is the one place that can answer.
   */
  framebufferWidths(): readonly number[] {
    return FRAMEBUFFER_WIDTHS
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
  private async emit(
    record: OutputRecord,
    payload: unknown,
    event: string = OUTPUT_STATE_EVENT,
  ): Promise<void> {
    try {
      await this.host.emitTo(record.label, event, payload)
    } catch (err) {
      logger.warn(`[multiOutput] ${event} emit to ${record.label} failed:`, err)
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
  /**
   * An output window is gone (rung 13, failure recovery case 1).
   *
   * The manager's own closes come through here too — `close()` ends in
   * a destroy like any other — so the first job is telling them apart,
   * and the second is making sure a departure the operator did not ask
   * for stops costing them anything. Until this existed a crashed
   * output stayed in `records`: it kept receiving diffs no window
   * applied, it kept its slot in the decoder budget, and the panel went
   * on listing it.
   *
   * A record that is already gone means `removeOutput` finished before
   * the destroy arrived, which is the ordinary ordering for the
   * manager's own close. There is nothing to classify and nothing to
   * report.
   */
  private handleDeparture(label: string): void {
    const record = this.records.get(label)
    if (!record) return

    const departure = classifyDeparture({
      managerInitiated: record.departing,
      sawClosing: record.announcedClosing,
    })
    // `removeOutput` is mid-flight and will do its own bookkeeping.
    // Touching `records` here would race it.
    if (departure === 'removed') return

    this.handles.delete(label)
    this.records.delete(label)
    reportOutputRemoved({ mode: record.mode, reason: removalReasonFor(departure) })
    if (departure === 'crashed') {
      // Counted against the *monitor*, not the output: the next window
      // put there is the one at risk, and it will carry a new label.
      this.crashStorm.record(monitorKeyOf(record.monitor))
      logger.error(
        `[multiOutput] ${label} crashed on ${record.monitor.name ?? 'an unnamed monitor'} ` +
          `(dataset ${record.lastEvent?.type ?? 'unknown'}) — removed`,
      )
      // A second event beside the removal, not instead of it: the
      // removal answers "how many outputs stopped and why", the failure
      // answers "how healthy is this installation", and a dashboard
      // wants to ask those separately. `retries: 0` and
      // `recovered: false` are the honest values — §3's table gives a
      // crash no auto-recovery at all, and the operator re-adds by
      // hand.
      reportOutputFailure({ kind: 'crash', retries: 0, recovered: false })
    } else {
      logger.info(`[multiOutput] ${label} was closed from its own window — removed`)
      // Persisted only for a *deliberate* close. An output the operator
      // shut by hand must not come back on the next launch just because
      // "Restore outputs" is ticked — that would make the close look
      // broken rather than honoured.
      //
      // A **crash is the opposite case** and must not persist. The
      // operator still wants that output; the display or the driver
      // took it away. Rewriting the config without it turns a
      // four-projector installation into a three-projector one
      // silently, with nothing on any screen to say which one went or
      // why — the invisible failure this whole module is written
      // against. Leaving it configured means the next launch tries
      // again, and if the display is still bad the storm guard stops
      // the loop where an operator can see it.
      //
      // This is also what keeps a shutdown cheap. `quit_app` is
      // `app.exit(0)`, not a per-window close, so if Tauri delivers
      // each output's destroy to this window before the process goes,
      // every one of them reads as a crash — no `output_closing`
      // precedes them. Unverified either way on hardware. With this
      // rule the worst that costs is some telemetry; without it, an
      // installation would lose its entire output configuration on
      // every ordinary quit.
      this.persist()
    }
    this.notifyChange()
  }

  /**
   * Subscribe to departures the operator did not initiate.
   *
   * The Outputs panel reads `outputs()` when it paints, so without this
   * a crash is invisible until the panel happens to be reopened. The
   * plan asks for a toast here; the app has no toast primitive, so this
   * is the honest half — an open panel updates itself, and the toast is
   * a later change rather than a thing invented in passing.
   */
  onOutputsChanged(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  private notifyChange(): void {
    for (const listener of this.changeListeners) {
      // Isolated for `globeStateEvents`' reason: a throwing panel must
      // not unwind into the manager's own bookkeeping.
      try {
        listener()
      } catch (err) {
        logger.warn('[multiOutput] an outputs listener threw:', err)
      }
    }
  }

  private handleOutputEvent(payload: unknown): void {
    const event = asOutputEvent(payload)
    if (!event) return
    const record = this.records.get(event.label)
    if (!record) return

    record.lastEvent = event
    if (event.type === 'output_closing') {
      // Held on its own field rather than read back off `lastEvent`,
      // because a health-check ping can land between this and the
      // destroy — and then the one fact that separates a hand-close
      // from a crash would have been overwritten by a heartbeat.
      record.announcedClosing = true
    }
    if (event.type === 'output_ready') {
      record.ready = true
      // Config first. A restored 8K output that received its state
      // before its resolution would render one or more frames at the
      // default and then reallocate — visible on a projector as a
      // resolution pop at every launch, for no reason but ordering.
      void this.emit(record, record.render, OUTPUT_RENDER_CONFIG_EVENT)
      const snapshot = this.aggregator.full()
      void this.emit(record, {
        ...snapshot,
        state: projectState(snapshot.state, record.view, record.mode),
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
  const { PhysicalPosition, PhysicalSize, availableMonitors, primaryMonitor } = windowApi

  type TauriMonitor = Awaited<ReturnType<typeof primaryMonitor>>
  const toOutputMonitor = (m: NonNullable<TauriMonitor>): OutputMonitor => ({
    name: m.name,
    position: { x: m.position.x, y: m.position.y },
    size: { width: m.size.width, height: m.size.height },
    scaleFactor: m.scaleFactor,
  })

  return {
    async availableMonitors() {
      const monitors = await availableMonitors()
      return monitors.map(toOutputMonitor)
    },

    async primaryMonitor() {
      const monitor = await primaryMonitor()
      return monitor ? toOutputMonitor(monitor) : null
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
        async onDestroyed(handler) {
          // `once`, not `on`: a window is destroyed exactly once, and
          // the unlisten is therefore not worth threading back out —
          // the subscription dies with the thing it is watching.
          //
          // This fires for *every* destroy, including the manager's own
          // `close()` above. Telling those apart is
          // `classifyDeparture`'s job, not this seam's: a host that
          // tried to filter here would need to know why the window is
          // going, which is exactly the state the manager holds.
          await win.once('tauri://destroyed', () => handler())
        },
      }
    },

    emitTo: (label, event, payload) => eventApi.emitTo(label, event, payload),

    listen: (event, handler) =>
      eventApi.listen(event, e => handler(e.payload)),
  }
}
