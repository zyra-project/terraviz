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
  OUTPUT_REATTACH_EVENT,
  OUTPUT_RENDER_CONFIG_EVENT,
  OUTPUT_STATE_EVENT,
  STATE_TICK_MS,
  DEFAULT_OUTPUT_MODE,
  defaultRenderConfig,
  isOutputLabel,
  outputLabel,
  outputLabelIndex,
  outputModeQuery,
  type MirroredGlobeState,
  type OutputEvent,
  type OutputMode,
  type OutputRenderConfig,
  type OutputStateMessage,
  type OutputWarpSet,
  type SharedStateMessage,
} from './protocol'
import {
  MAX_WARP_IMPORT_BYTES,
  assembleWarpSet,
  readWarpSources,
  type WarpImportRefusal,
  type WarpPlacement,
  type WarpSet,
  type WarpSource,
  type WarpSourcesResult,
} from './warpImport'
import { createWarpSetStore, type WarpSetStore } from './warpStorage'
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
  viewSettingsFrom,
  type OutputConfigStore,
  type PersistedOutput,
} from './outputPersistence'
import {
  OUTPUT_CLOSING_GRACE_MS,
  OUTPUT_REATTACH_TIMEOUT_MS,
  classifyDeparture,
  createCrashStormGuard,
  monitorKeyOf,
  outputHealthState,
  type OutputHealth,
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
import type { OutputRemovedReason } from '../../types'
import { logger } from '../../utils/logger'

/** Where the output bundle lands in the build. `vite.config.ts` roots
 *  at `src/`, so `src/output/output.html` becomes this. A window is
 *  spawned at this plus `outputModeQuery(mode)` — bare for
 *  `sos-equirect`, as before rung 16. */
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
  /**
   * Output windows this app already owns, by label (case 6).
   *
   * Non-empty only when a *previous* manager spawned them and this one
   * has never heard of them — a control-window webview that reloaded or
   * crashed and came back, leaving its `output-*` siblings alive and
   * still rendering. Everything else the platform has open is filtered
   * out here: the label grammar is the whole membership test, and it is
   * the same grammar the Tauri capability glob scopes on.
   *
   * A host with no notion of sibling windows returns `[]`, which is
   * also what a healthy first launch returns — so the manager's scan
   * costs one call and stops.
   */
  existingOutputs(): Promise<{ label: string; handle: OutputWindowHandle }[]>
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
  /** Clock behind the stale badge's freshness window. Injected so a
   *  test can age a complaint without waiting five seconds. */
  nowMs?: () => number
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
  /**
   * Where warp sets are kept (rung 16). Injected for the reason `store`
   * is: a test drives it without `localStorage`.
   */
  warpStore?: WarpSetStore
}

/**
 * A file as the panel holds it — `File` satisfies this — so the manager
 * can refuse an oversized pick by its size before reading a byte.
 */
export interface WarpFileLike {
  readonly name: string
  readonly size: number
  arrayBuffer(): Promise<ArrayBuffer>
}

/** Why a warp set could not be put on an output. The panel words each `code`. */
export type WarpAssignRefusal =
  | WarpImportRefusal
  | { readonly code: 'no-output' }
  /** Only a `projector-warp` output draws a warp. */
  | { readonly code: 'not-a-warp-output' }
  /** Storage refused the set — no room for it, or no storage at all. */
  | { readonly code: 'storage'; readonly reason: 'unavailable' | 'no-room' }

export type WarpAssignment =
  | { readonly ok: true; readonly id: string; readonly meshes: number }
  | { readonly ok: false; readonly refusal: WarpAssignRefusal }

/** The set as it crosses to the output: the meshes without the file names, which it has no use for. */
function wireWarpSet(id: string, set: WarpSet): OutputWarpSet {
  return {
    id,
    texture: set.texture === null ? null : { ...set.texture },
    meshes: set.meshes.map(({ id: meshId, viewport, text }) => ({ id: meshId, viewport: { ...viewport }, text })),
  }
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
  /**
   * When this output last reported that it had heard nothing (rung 13,
   * case 3), or `null` if it never has.
   *
   * The raw fact; `health` below is what the panel reads. Deliberately
   * **not** persisted — `toPersistedOutput` takes a `Pick`, so this
   * stays out by construction, and a complaint from last Tuesday means
   * nothing to a window that has not been spawned yet.
   */
  lastHealthCheckAtMs: number | null
  /**
   * Whether this output last said its WebGL context was gone (rung 13,
   * case 5).
   *
   * A latch rather than a timestamp, unlike `lastHealthCheckAtMs`
   * beside it, because the two facts decay differently. A stale-link
   * complaint expires — the output stops pinging when it recovers, and
   * silence is how the manager learns that. A lost context does not:
   * the output says so once and stays quiet about it, so the only
   * thing that can clear this is the matching
   * `output_gpu_recovered`. Ageing it out on a TTL would quietly
   * declare a black projector healthy after five seconds.
   *
   * Not persisted, for `lastHealthCheckAtMs`' reason: `toPersistedOutput`
   * takes a `Pick`, and a GPU that failed last Tuesday says nothing
   * about a window that has not been spawned yet.
   */
  gpuLost: boolean
  /**
   * The dataset this output last reported a dead stream for, or `null`.
   * One `hls-stalled` row per output per dataset, cleared when the
   * control window publishes a dataset. The output already sends one
   * per stream; this is the bound for an output that does not, a buggy
   * future rebuild loop or a compromised window. Not persisted.
   */
  stallReportedFor: string | null
  /**
   * The badge, derived from `ready`, `lastHealthCheckAtMs` and
   * `gpuLost`, and kept current by the heartbeat.
   *
   * Stored rather than derived at read time because the panel cannot
   * derive it: every `multiOutput/` import in `outputUI.ts` is
   * type-only, so calling `outputHealthState` there would pull this
   * cluster into the web entry chunk. Same reason `framebufferWidths()`
   * exists.
   */
  health: OutputHealth
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
  /**
   * The warp set this output names (rung 16) — what is persisted — or
   * `null`.
   *
   * Held apart from `render.warp`, the set as loaded, because the two
   * differ exactly when a stored set could not be read. The output then
   * draws nothing, and the reference is kept, so the calibration is
   * neither dropped from the config nor deleted from storage by the
   * next save — a set a later build refuses is still the operator's.
   */
  warpRef: string | null
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
  private readonly nowMs: () => number
  private readonly controlPanels: () => number
  private readonly machineDecoderBudget: () => number
  private readonly warpStore: WarpSetStore

  constructor(host: MultiOutputHost, deps: MultiOutputDeps = {}) {
    this.host = host
    this.store = deps.store ?? createOutputConfigStore()
    this.sleep =
      deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
    this.nowMs = deps.nowMs ?? (() => Date.now())
    this.controlPanels = deps.controlPanels ?? (() => 1)
    this.machineDecoderBudget = deps.machineDecoderBudget ?? maxVideoPanels
    this.warpStore = deps.warpStore ?? createWarpSetStore()
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
      options.mode ?? DEFAULT_OUTPUT_MODE,
      { ...DEFAULT_VIEW_SETTINGS, ...definedOnly(options.view) },
      { ...defaultRenderConfig(), ...definedOnly(options.render) },
      null,
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
    warpRef: string | null,
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

    // The mode rides the URL because that is the one thing a window can
    // read before any IPC exists (`outputModeQuery`): it has to know
    // what it is before it can tell a view meant for something else.
    const handle = await this.host.createWindow(label, `${OUTPUT_ENTRY_URL}${outputModeQuery(mode)}`)

    const record: OutputRecord = {
      label,
      mode,
      view,
      render,
      monitor,
      ready: false,
      lastEvent: null,
      lastHealthCheckAtMs: null,
      gpuLost: false,
      stallReportedFor: null,
      health: 'starting',
      departing: false,
      announcedClosing: false,
      warpRef,
    }
    // **Before the window can speak, not after it is shown.** The
    // webview starts loading at `createWindow`, so the output's own
    // boot runs concurrently with everything below — and it announces
    // `output_ready` the moment its listeners are up.
    // `handleOutputEvent` drops an event whose label has no record, so
    // an announcement that arrives before this line is *lost*: the
    // record stays `ready: false` for the life of the window, the
    // manager never sends the first snapshot or the render config, and
    // the operator gets an output stuck on the idle Earth with no error
    // anywhere. The placement sequence is four awaited IPC calls and
    // `onDestroyed` is a fifth, so that gap was never small.
    this.records.set(label, record)
    this.handles.set(label, handle)

    try {
      // Registered before placement rather than after, because a window
      // can die at any point in it, and a host whose registration
      // rejects should take the cleanup path below rather than throwing
      // past it.
      await handle.onDestroyed(() => this.handleDeparture(label))
      // Order is load-bearing — see the module header.
      await handle.setPosition(monitor.position.x, monitor.position.y)
      await handle.setSize(monitor.size.width, monitor.size.height)
      await handle.setFullscreen(true)
      await handle.show()
    } catch (err) {
      // Dropped from the maps *before* the close, so the destroy this
      // triggers finds no record and is ignored as the manager's own
      // teardown rather than classified as a crash — the same ordering
      // `removeOutput` gets from `departing`.
      //
      // Closing it is not optional: the window exists, and a spawn that
      // threw leaves nothing else able to reach it — `closeAll()`
      // included. On an installation that is a hidden, undecorated
      // window the operator cannot get rid of without killing the app.
      this.records.delete(label)
      this.handles.delete(label)
      try {
        await handle.close()
      } catch (closeErr) {
        logger.warn(`[multiOutput] could not close half-spawned ${label}:`, closeErr)
      }
      throw err
    }

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
    await this.discard(label, 'operator-close')
  }

  /**
   * Close one window, forget it, and say why it went.
   *
   * Shared by the operator's Remove and by the boot scan's timeout for
   * the reason `spawn()` is shared by Add and restore: the *ordering*
   * is the correctness content, and a second copy is a second place for
   * it to drift. Only the reported reason differs. `null` reports
   * nothing, for a window no reason in the schema is true of.
   */
  private async discard(label: string, reason: OutputRemovedReason | null): Promise<void> {
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
    // Only for a label that was actually here: `removeOutput` is
    // documented safe to call twice (the panel's Remove and a hand
    // close race), and a second call must not report a second removal.
    //
    // `closeAll()` funnels through here, so a future shutdown path that
    // calls it would report one `operator-close` per output. Nothing
    // calls it outside tests today; when something does, it wants its
    // own reason rather than this one.
    if (record && reason !== null) reportOutputRemoved({ mode: record.mode, reason })
    // **Persisted only for a deliberate removal**, which is
    // `commitDeparture`'s rule and has to be the same rule here or the
    // two disagree about what a crash costs. An output the operator
    // shut by hand must not come back next launch; one that stopped
    // for any other reason must, because they still want it and
    // something took it away.
    //
    // This started as an unconditional persist, which was invisible
    // while `removeOutput` was the only caller — every removal was
    // deliberate. The boot scan's reattach timeout classifies as
    // `crash`, so it quietly un-configured an output that failed to
    // answer, turning a transient IPC outage into a permanent one.
    // Caught in review.
    if (reason === 'operator-close') {
      this.persist()
      // Deliberate, so the set goes too if nothing else names it — the
      // one kind of departure `warpStorage` deletes on.
      this.releaseWarp(record?.warpRef ?? null)
    }
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
    // Never the warp: a set goes through `importWarpSet`, which stores it
    // before pointing an output at it — set here, it would be sent and
    // never kept.
    render: Partial<Omit<OutputRenderConfig, 'warp'>>,
  ): Promise<void> {
    const record = this.records.get(label)
    if (!record) return
    record.render = { ...record.render, ...definedOnly(render) }
    this.persist()
    if (!record.ready) return
    await this.emit(record, record.render, OUTPUT_RENDER_CONFIG_EVENT)
  }

  /**
   * Read what the operator picked into warp sources (rung 16) — one
   * sphere-sim bundle, or `.data` files — or say why not.
   *
   * Here rather than in the panel because the parser is here: every
   * `multiOutput/` import in `outputUI` is type-only, and a runtime import
   * of it there would pull the contract into the web entry graph. Sizes
   * are checked before a byte is read, so a wrong multi-gigabyte pick is
   * refused without being loaded. A file that cannot be read at all
   * rejects, as a failed `addOutput` does.
   */
  async readWarpFiles(files: readonly WarpFileLike[]): Promise<WarpSourcesResult> {
    const bytes = files.reduce((sum, f) => sum + f.size, 0)
    if (bytes > MAX_WARP_IMPORT_BYTES) return { ok: false, refusal: { code: 'too-large', bytes } }
    const read = await Promise.all(
      files.map(async f => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
    )
    return readWarpSources(read)
  }

  /**
   * Put a warp set on a `projector-warp` output (rung 16): assemble it by
   * its bundle's own layout or by the operator's answer, store it under
   * its own key, point the output at it and send it — or refuse, changing
   * nothing.
   *
   * Stored **before** the output is pointed at it, so a set that does not
   * fit is refused whole and the output keeps the one it had. The set it
   * replaces is deleted once nothing names it, which is one of the
   * deliberate paths `warpStorage` deletes on.
   */
  async importWarpSet(
    label: string,
    sources: readonly WarpSource[],
    placement: WarpPlacement,
  ): Promise<WarpAssignment> {
    const record = this.records.get(label)
    if (!record) return { ok: false, refusal: { code: 'no-output' } }
    if (record.mode !== 'projector-warp') return { ok: false, refusal: { code: 'not-a-warp-output' } }
    const assembled = assembleWarpSet(sources, placement)
    if (!assembled.ok) return assembled
    const { id } = assembled
    // The id covers the meshes and where they go, not the texture a
    // layout stated, so the same meshes imported with and without their
    // layout.json are one set. A stated texture outranks an unstated one:
    // the meshes were exported with one rotation, and an import that
    // does not say what it was cannot un-say it.
    const stated = assembled.set.texture === null ? this.warpStore.read(id) : null
    const set = stated?.ok && stated.set.texture !== null ? stated.set : assembled.set
    if (set === assembled.set) {
      const stored = this.warpStore.write(id, set, new Date(this.nowMs()).toISOString())
      if (!stored.ok) return { ok: false, refusal: { code: 'storage', reason: stored.reason } }
    }
    const previous = record.warpRef
    record.warpRef = id
    this.persist()
    if (previous !== id) this.releaseWarp(previous)
    // Every output naming this set gets it as now stored, not only this
    // one. Otherwise another row drawing the same meshes would state a
    // different rotation from this one until the next launch. Its
    // geometry is unchanged, and the output compares the id and rebuilds
    // nothing.
    for (const holder of this.records.values()) {
      if (holder.warpRef !== id) continue
      holder.render = { ...holder.render, warp: wireWarpSet(id, set) }
      if (holder.ready) await this.emit(holder, holder.render, OUTPUT_RENDER_CONFIG_EVENT)
    }
    return { ok: true, id, meshes: set.meshes.length }
  }

  /**
   * Take a `projector-warp` output's set away, so it draws nothing. The
   * set is deleted if no other output names it — the operator asked for
   * this, and a stored calibration nobody uses is space nobody gets back.
   */
  async clearOutputWarp(label: string): Promise<void> {
    const record = this.records.get(label)
    if (!record || (record.warpRef === null && record.render.warp === null)) return
    const previous = record.warpRef
    record.warpRef = null
    record.render = { ...record.render, warp: null }
    this.persist()
    this.releaseWarp(previous)
    if (record.ready) await this.emit(record, record.render, OUTPUT_RENDER_CONFIG_EVENT)
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
  /**
   * Adopt `output-*` windows that outlived the manager that spawned
   * them (`docs/MULTI_MONITOR_PLAN.md` §3 "Failure recovery", case 6).
   *
   * The case is a control window whose **webview** reloaded or crashed
   * and came back — a dev reload, a renderer the OS recycled — leaving
   * its sibling output windows alive and still rendering while a fresh
   * `MultiOutputManager` boots with an empty `records` map. The plan
   * frames this as a control-window *crash* and describes killing the
   * process to reproduce it; that is not the same thing, and the
   * distinction matters to anyone testing this. Every window belongs to
   * one Tauri process, so killing it takes the outputs with it. What
   * survives is a reload of the page, not a death of the app.
   *
   * Without this, those windows are unreachable in every sense that
   * counts: `handleOutputEvent` drops an event whose label has no
   * record, so their health pings go nowhere; the panel cannot list or
   * remove them; the decoder budget does not count them; `closeAll()`
   * cannot close them. They keep rendering a frame from before the
   * reload, forever, which on a projector is indistinguishable from
   * working.
   *
   * **Unconditional, unlike `restoreOutputs`.** The opt-in governs
   * whether the manager *spawns* windows on launch; a window that is
   * already on a projector exists whether or not anyone opted in, and
   * refusing to adopt it would leave the operator with a display they
   * cannot reach. It still costs a launch that has never used outputs
   * exactly one call, because a host with nothing to report returns an
   * empty array and this stops before enumerating a monitor or opening
   * the link — the same property `restoreOutputs` protects.
   *
   * **Runs before `restoreOutputs`, and that ordering is load-bearing.**
   * A surviving window holds its label, and the restore spawns from the
   * same persisted entries by label — so without the scan first, a
   * restore would try to create a second `output-1` on a monitor that
   * already has one. Adopted labels are in `records` by the time the
   * restore reads the config, and it skips them.
   *
   * Three things get closed rather than adopted, and each is the same
   * judgement: the manager will not put a row in the panel it cannot
   * describe truthfully.
   *
   * - **A label with no persisted entry.** There is nothing to build a
   *   record from — no monitor, no view settings, no render config —
   *   and `reportOutputRemoved` needs a `mode` this window has not
   *   told us. Every alternative is a guess presented as fact, which is
   *   the failure the name-only monitor match was rejected for. It
   *   costs a projector going black on a path that needs the config to
   *   have been reset while windows were live.
   * - **A monitor that is no longer enumerated.** The same rule the
   *   restore applies, and the reason `monitor-gone` exists.
   * - **A window that does not answer the poke** within
   *   `OUTPUT_REATTACH_TIMEOUT_MS`. Absence is the signal, exactly as
   *   it is for a departure.
   */
  async adoptOrphanedOutputs(): Promise<OutputRecord[]> {
    let existing: { label: string; handle: OutputWindowHandle }[]
    try {
      existing = await this.host.existingOutputs()
    } catch (err) {
      // A host that cannot enumerate its own windows costs the scan and
      // nothing else — the restore behind it still runs, and on the
      // overwhelmingly common launch there was nothing to find anyway.
      logger.warn('[multiOutput] could not scan for orphaned outputs:', err)
      return []
    }
    if (existing.length === 0) return []

    // Reserve every label that is **on screen**, before deciding what
    // to do with any of it — not just the ones that end up adopted.
    // A window whose `close()` rejects is still out there holding its
    // label, and minting that label again on the operator's next Add
    // asks Tauri for a duplicate and fails. Doing this first also
    // covers the labels closed below.
    for (const { label } of existing) {
      const index = outputLabelIndex(label)
      if (index !== null) this.nextIndex = Math.max(this.nextIndex, index + 1)
    }

    const persisted = new Map(this.store.read().outputs.map(o => [o.label, o]))
    const monitors = await this.host.availableMonitors()

    // Started before the first poke, for the reason the restore starts
    // before its first spawn: the answer to a poke is an `output_ready`
    // over the link, and a listener installed afterwards races it.
    await this.start()

    const adopted: OutputRecord[] = []
    for (const { label, handle } of existing) {
      const config = persisted.get(label)
      if (!config) {
        logger.warn(`[multiOutput] closing ${label}: no persisted entry describes it`)
        await this.closeUnowned(label, handle)
        continue
      }
      const index = matchMonitorIndex(config, monitors)
      if (index === null) {
        logger.warn(
          `[multiOutput] closing ${label}: no monitor matches ` +
            `${config.monitorName ?? '(unnamed)'} at ` +
            `${config.monitorOrigin.x},${config.monitorOrigin.y}`,
        )
        reportOutputRemoved({ mode: config.mode, reason: 'monitor-gone' })
        await this.closeUnowned(label, handle)
        continue
      }

      const record: OutputRecord = {
        label,
        mode: config.mode,
        view: viewSettingsFrom(config),
        render: renderConfigFrom(config, this.loadWarp(config)),
        monitor: monitors[index],
        // `false` until it answers, which is what the timeout below
        // reads and what keeps the badge on `starting` meanwhile. An
        // adopted window has not proved anything yet.
        ready: false,
        lastEvent: null,
        lastHealthCheckAtMs: null,
        gpuLost: false,
        stallReportedFor: null,
        health: 'starting',
        departing: false,
        announcedClosing: false,
        warpRef: config.warpId,
      }
      // Registered before the poke for the reason `spawn()` registers
      // before placement: the reply is an `output_ready`, and
      // `handleOutputEvent` drops one whose label has no record.
      this.records.set(label, record)
      this.handles.set(label, handle)
      adopted.push(record)

      try {
        await handle.onDestroyed(() => this.handleDeparture(label))
      } catch (err) {
        // Not fatal the way it is in `spawn()`, and the difference is
        // reachability: there, a handle that cannot be watched belongs
        // to a window nothing else can get at, so leaking it strands an
        // undecorated window the operator cannot close. Here the window
        // predates this manager, is already rendering correctly, and is
        // in `records` — so the panel lists it and Remove still closes
        // it through the same handle.
        //
        // The cost is worse than an earlier version of this comment
        // said ("its departure goes unnoticed"): the record also holds
        // a **decoder-budget slot** until someone removes it by hand,
        // and the budget is a hard gate on adding outputs. Raised in
        // review, which proposed closing the window instead. Not taken:
        // that trades a projector showing correct imagery for a
        // bookkeeping win, and this feature's stated policy is to
        // preserve the last good visible state. Logged at error level
        // so it is not the quiet kind of leak.
        logger.error(`[multiOutput] could not watch ${label} for departure:`, err)
      }
      try {
        await this.host.emitTo(label, OUTPUT_REATTACH_EVENT, {})
      } catch (err) {
        logger.warn(`[multiOutput] could not poke ${label}:`, err)
      }
    }

    if (adopted.length === 0) return []

    // One wait for the whole set rather than one per window: they were
    // poked together and the timeout is a property of the slowest, so
    // serialising it would multiply a five-second worst case by the
    // number of projectors.
    await this.sleep(OUTPUT_REATTACH_TIMEOUT_MS)

    const live: OutputRecord[] = []
    for (const record of adopted) {
      // Re-read rather than trusting the captured object: a window can
      // have departed on its own during the wait, in which case
      // `commitDeparture` has already dealt with it. One that answered
      // as a different geometry is already being closed by the event
      // handler, and it did answer, so it must not be reported silent.
      const current = this.records.get(record.label)
      if (!current || current.departing) continue
      if (current.ready) {
        live.push(current)
        // The failure being reported is case 3's, because that is what
        // the output experienced: its control window went quiet. The
        // poke is the one retry, and this one worked.
        reportOutputFailure({ kind: 'ipc-silence', retries: 1, recovered: true })
        logger.info(`[multiOutput] reattached ${current.label}`)
        continue
      }
      logger.error(
        `[multiOutput] ${current.label} did not answer the reattach poke — closing`,
      )
      reportOutputFailure({ kind: 'ipc-silence', retries: 1, recovered: false })
      await this.discard(current.label, 'crash')
    }

    this.notifyChange()
    return live
  }

  /**
   * Close a window this manager never took a record for.
   *
   * Separate from `discard` because there is nothing to forget and
   * nothing to report — no record, no mode, no persistence to rewrite.
   * A rejection is absorbed for `discard`'s reason: one stuck window
   * must not strand the scan.
   */
  private async closeUnowned(label: string, handle: OutputWindowHandle): Promise<void> {
    try {
      await handle.close()
    } catch (err) {
      logger.warn(`[multiOutput] could not close ${label}:`, err)
    }
  }

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
      // Already on screen and already ours — the boot scan adopted it
      // before this ran (case 6). Spawning would ask Tauri for a second
      // window under a label it already has, and the plan's whole
      // premise for case 6 is that the imagery on the projector never
      // went away.
      if (this.records.has(output.label)) continue
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
            viewSettingsFrom(output),
            renderConfigFrom(output, this.loadWarp(output)),
            output.warpId,
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

  /**
   * The set a persisted output names, loaded and checked, or `null` —
   * which a `projector-warp` window renders as nothing. The caller keeps
   * the reference either way (`OutputRecord.warpRef`), so a set that
   * cannot be read costs the output its warp, never the calibration.
   */
  private loadWarp(output: PersistedOutput): OutputWarpSet | null {
    if (output.mode !== 'projector-warp' || output.warpId === null) return null
    const read = this.warpStore.read(output.warpId)
    if (!read.ok) {
      logger.warn(
        `[multiOutput] ${output.label}'s warp set ${output.warpId} could not be read ` +
          `(${read.reason}${read.refusal ? `: ${read.refusal.code}` : ''}) — it will draw nothing`,
      )
      return null
    }
    return wireWarpSet(output.warpId, read.set)
  }

  /**
   * Delete a stored set the operator has let go of — unless another
   * output, live or configured, still names it. Only the deliberate paths
   * call this; a set orphaned by a failure stays (see `warpStorage`).
   */
  private releaseWarp(id: string | null): void {
    if (id === null) return
    const named =
      [...this.records.values()].some(r => r.warpRef === id) ||
      this.store.read().outputs.some(o => o.warpId === id)
    if (!named) this.warpStore.remove(id)
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
    // A new dataset is a new stream on every output, owed its own report
    // if it dies.
    if ('dataset' in patch) for (const record of this.records.values()) record.stallReportedFor = null
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
    // Before the broadcast, because half the badge's transitions are an
    // *absence*: an output stops complaining by going quiet, and no
    // event arrives to say so. This is the only thing that runs on a
    // schedule, so it is the only place that silence can be noticed.
    if (this.refreshHealth()) this.notifyChange()
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
  private async handleDeparture(label: string): Promise<void> {
    const departure = this.readDeparture(label)
    if (!departure) return
    // Anything but a crash is unambiguous — act now.
    if (departure !== 'crashed') {
      this.commitDeparture(label, departure)
      return
    }

    // A crash is an *absence*, and an absence is only evidence once the
    // announcement has had time to arrive. The output fires
    // `output_closing` and lets its window go without waiting, so on an
    // Alt+F4 the two are in flight together; reading absence
    // immediately makes the winner of that race decide whether a
    // healthy monitor collects a strike. See
    // `OUTPUT_CLOSING_GRACE_MS`. Only this branch waits, and the wait
    // is invisible: the window is already gone.
    await this.sleep(OUTPUT_CLOSING_GRACE_MS)
    const settled = this.readDeparture(label)
    if (!settled) return
    this.commitDeparture(label, settled)
  }

  /** Classify a departure, or `null` when there is nothing to act on —
   *  the record is already gone (the manager's own close finished
   *  first) or `removeOutput` is mid-flight and doing its own
   *  bookkeeping, and touching `records` here would race it. */
  private readDeparture(label: string): OutputDeparture | null {
    const record = this.records.get(label)
    if (!record) return null
    const departure = classifyDeparture({
      managerInitiated: record.departing,
      sawClosing: record.announcedClosing,
    })
    return departure === 'removed' ? null : departure
  }

  private commitDeparture(label: string, departure: OutputDeparture): void {
    const record = this.records.get(label)
    if (!record) return

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
      this.releaseWarp(record.warpRef)
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

    // A window that booted as a different geometry from its record is
    // closed, never driven. A projector-warp output driven as the other
    // mode would put an unwarped globe across projectors calibrated for
    // a warp, and that picture looks as though it worked. Not serving it
    // is not enough: an output nobody drives still renders its own idle
    // Earth. The spawn URL and the record come from one call, so this
    // should never run; the reachable way in is adoption, where the
    // record is read from the stored config and the mode from a window
    // that outlived the page that wrote it.
    //
    // The removal is not persisted and not reported. The configuration
    // is not what is wrong, so the next restore spawns the output again
    // from the right URL. And no removal reason in the telemetry schema
    // is true of a build disagreeing with itself, so the error log is
    // the signal.
    if (event.type === 'output_ready' && event.mode !== record.mode) {
      logger.error(
        `[multiOutput] ${event.label} announced '${event.mode}' but was spawned as '${record.mode}' — ` +
          'closing it rather than driving it as a geometry it is not',
      )
      void this.discard(event.label, null).then(() => this.notifyChange())
      return
    }

    record.lastEvent = event
    if (event.type === 'output_closing') {
      // Held on its own field rather than read back off `lastEvent`,
      // because a health-check ping can land between this and the
      // destroy — and then the one fact that separates a hand-close
      // from a crash would have been overwritten by a heartbeat.
      record.announcedClosing = true
    }
    if (event.type === 'output_health_check') {
      // The output has heard nothing for `IPC_STALE_MS` and is asking
      // whether anyone is there (rung 13, case 3). Reaching this line
      // is the answer.
      logger.warn(
        `[multiOutput] ${event.label} reports the link stale ` +
          `(${event.silentMs} ms quiet) — resyncing`,
      )
      record.lastHealthCheckAtMs = this.nowMs()
    }
    if (event.type === 'output_gpu_lost') {
      // The one failure a *healthy* link reports (rung 13, case 5).
      // Every other detector here reads an absence, and all of them
      // are blind to this: the window is up, the channel works, the
      // heartbeat is answered, and the sphere is black.
      logger.error(`[multiOutput] ${event.label} lost its WebGL context — it is showing nothing`)
      record.gpuLost = true
      // The **opening** row of an incident: nothing has recovered yet
      // and nothing has been attempted here, so `0` and `false` are
      // literal rather than lazy defaults — the case
      // `reportOutputFailure` refuses to supply them for.
      //
      // A first draft emitted only this row and argued that one row per
      // incident avoided double-counting. That was wrong, and review
      // caught it: `recovered` is defined on the schema as *whether the
      // output carried on afterwards*, and an output whose context
      // Three rebuilds does carry on — so a never-updated `false`
      // reported every recovered installation as unrecovered, on the
      // very dashboard panel this rung added. Wrong data is worse than
      // redundant data, so the recovery below closes the pair.
      reportOutputFailure({ kind: 'gpu-loss', retries: 0, recovered: false })
    }
    if (event.type === 'output_gpu_recovered') {
      logger.warn(`[multiOutput] ${event.label} says its WebGL context is back`)
      // The **closing** row, and only for an incident this manager
      // actually opened. Without the latch check a reattached output
      // reporting its standing `restored` state would open a recovery
      // for a loss that never happened here, and a dashboard would
      // count recoveries this installation never had.
      //
      // `retries: 1` credits the one automatic attempt that was made —
      // the browser handing the context back and Three's
      // `initGLContext()` rebuilding on it. Nothing in this repo
      // retried, which is why the opening row says `0`.
      if (record.gpuLost) {
        reportOutputFailure({ kind: 'gpu-loss', retries: 1, recovered: true })
      }
      record.gpuLost = false
    }
    if (event.type === 'output_dataset_stalled') {
      // The output's stream died: it would not load while still wanted,
      // or hls.js spent its retry budget after it had (`datasetMirror`).
      // The output keeps its last frame and nothing rebuilds the stream
      // yet, which is rung 13's single HLS rebuild, so `0` and `false`
      // are literal. `retries` counts what this side attempted, which is
      // nothing; hls.js's own recoveries happen inside the output and are
      // not counted.
      //
      // Not from a window on its way out, whose stream ending is the
      // close, and at most once per output per dataset (`stallReportedFor`).
      const datasetId = typeof event.datasetId === 'string' ? event.datasetId.slice(0, 64) : null
      const key = datasetId ?? ''
      if (!record.departing && !record.announcedClosing && record.stallReportedFor !== key) {
        record.stallReportedFor = key
        logger.error(`[multiOutput] ${event.label} could not play ${datasetId ?? 'its dataset'}`)
        reportOutputFailure({ kind: 'hls-stalled', retries: 0, recovered: false })
      }
    }
    // A ping and an announcement are served by **one** path, not two.
    // Both prove the same thing — the window is up and listening — and
    // the config-before-state ordering below is load-bearing, so a
    // second copy of it is a second place for it to drift.
    //
    // Answering a ping is also how an output recovers when its
    // `output_ready` was missed: a manager restart, or the
    // spawn-ordering race, would otherwise leave it un-served for the
    // life of the window. And a resync is the right reply rather than
    // a bare acknowledgement — whatever cost it the heartbeat may have
    // cost it a diff, and a full snapshot is the same round trip.
    //
    // But a ping does not say what geometry the window is, so one from
    // a window that has never announced is answered with the reattach
    // poke rather than served. The window replies with an
    // `output_ready`, which carries the mode checked above. `ready`
    // therefore means the window has said it is the geometry its record
    // is, and nothing is sent to one that has not. The recovery costs
    // one more round trip.
    if (event.type === 'output_health_check' && !record.ready) {
      void this.emit(record, {}, OUTPUT_REATTACH_EVENT)
    } else if (event.type === 'output_ready' || event.type === 'output_health_check') {
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
    // Every branch above can move a badge — a ping makes one stale, an
    // announcement takes one out of `starting`, a closing puts it back,
    // and the two GPU reports set and clear the latch that outranks all
    // of them.
    if (this.refreshHealth()) this.notifyChange()
  }

  /**
   * Re-derive every output's badge, and say whether any of them moved.
   *
   * Called from `tick()` as well as from the event handler, because
   * half the transitions are the *absence* of an event: an output stops
   * complaining by going quiet, and nothing arrives to say so. The
   * heartbeat is already running once a second for the broadcast, so
   * this costs a subtraction per output and needs no timer of its own.
   *
   * Returns a boolean rather than notifying itself, so a caller that is
   * about to notify for its own reasons does not fire twice.
   */
  private refreshHealth(): boolean {
    const now = this.nowMs()
    let changed = false
    for (const record of this.records.values()) {
      const next = outputHealthState(record, now)
      if (next !== record.health) {
        record.health = next
        changed = true
      }
    }
    return changed
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
  const [{ WebviewWindow, getAllWebviewWindows }, windowApi, eventApi] = await Promise.all([
    import('@tauri-apps/api/webviewWindow'),
    import('@tauri-apps/api/window'),
    import('@tauri-apps/api/event'),
  ])
  const { PhysicalPosition, PhysicalSize, availableMonitors, primaryMonitor } = windowApi

  /**
   * One window, as the manager's handle.
   *
   * Shared by `createWindow` and `existingOutputs` because an adopted
   * window has to be drivable in exactly the same ways a spawned one
   * is — the manager closes it, watches it depart and counts it against
   * the budget without knowing which it was.
   */
  const toHandle = (win: InstanceType<typeof WebviewWindow>): OutputWindowHandle => ({
    setPosition: (x, y) => win.setPosition(new PhysicalPosition(x, y)),
    setSize: (w, h) => win.setSize(new PhysicalSize(w, h)),
    setFullscreen: on => win.setFullscreen(on),
    show: () => win.show(),
    close: () => win.close(),
    async onDestroyed(handler) {
      // `once`, not `on`: a window is destroyed exactly once, and the
      // unlisten is therefore not worth threading back out — the
      // subscription dies with the thing it is watching.
      //
      // This fires for *every* destroy, including the manager's own
      // `close()`. Telling those apart is `classifyDeparture`'s job,
      // not this seam's: a host that tried to filter here would need to
      // know why the window is going, which is exactly the state the
      // manager holds.
      await win.once('tauri://destroyed', () => handler())
    },
  })

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
      return toHandle(win)
    },

    async existingOutputs() {
      // Every window this app owns, not only the ones this manager
      // spawned — which is the entire point on a control window whose
      // page reloaded (case 6). The label grammar is the membership
      // test, and `isOutputLabel` is the same predicate the Tauri
      // capability glob encodes, so a window this returns is one the
      // `output-*` capability already scoped.
      const all = await getAllWebviewWindows()
      return all
        .filter(win => isOutputLabel(win.label))
        .map(win => ({ label: win.label, handle: toHandle(win) }))
    },

    emitTo: (label, event, payload) => eventApi.emitTo(label, event, payload),

    listen: (event, handler) =>
      eventApi.listen(event, e => handler(e.payload)),
  }
}
