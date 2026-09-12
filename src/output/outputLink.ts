// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The output window's side of the control ↔ output link
 * (`docs/MULTI_MONITOR_PLAN.md` §3).
 *
 * Everything the manager broadcasts has, until now, been broadcast at
 * nobody: no output emitted `output_ready`, so `readyRecords()` was
 * always empty and the whole send path was dead code in a real launch.
 * This is the other end.
 *
 * ## What it does, and the two rules that carry the correctness
 *
 * **A diff is applied only if it is newer; a snapshot is applied
 * always.** The output coalesces queued messages most-recent-wins, so a
 * late diff arriving after a fresh one would silently show the wrong
 * frame — hence `seq`. But a *snapshot* is not a new event: `full()`
 * deliberately does not advance `seq`, because it restates a point the
 * sequence already reached. Two things depend on accepting it anyway:
 * the idle heartbeat, which resyncs an output that missed a diff by
 * sending a full at the *same* `seq` it already holds, and a manager
 * restart, after which `seq` resets to a low number and arrives with a
 * full. Gating snapshots on `seq` would break both — the first silently,
 * the second permanently.
 *
 * That leaves one assumption worth naming: a snapshot that genuinely is
 * stale, delivered *after* a newer diff, would roll state back. It
 * relies on the event channel delivering in order, which Tauri's does.
 *
 * **A snapshot is not "everything changed".** The heartbeat sends a
 * full every second while the globe is idle. An output that reported
 * every key on each one would rebuild its HLS instance once per second,
 * on a projector, for the life of the session. So an accepted message
 * reports only the keys whose values actually *differ*, compared with
 * `stateEquality`'s `sameValue` — the same function the aggregator uses
 * to decide what to send, because two answers to that question is the
 * bug itself.
 *
 * ## Ordering at connect
 *
 * The listener is installed **before** `output_ready` is emitted. The
 * manager replies to that event by marking the record ready and sending
 * its first full snapshot immediately; emitting first would race the
 * listener against the reply, and the output would sit on the idle Earth
 * until the next heartbeat.
 *
 * ## Seams
 *
 * `OutputLinkHost` is the whole platform surface — identity, listen,
 * emit — so the link is testable with no Tauri, no window and no second
 * monitor, the same trade `MultiOutputHost` makes on the control side.
 * `createTauriLinkHost()` is the only Tauri importer here.
 */

import { IDENTITY_PARAMS } from './equirectRtt'
import { sameValue } from '../services/multiOutput/stateEquality'
import {
  OUTPUT_EVENT,
  OUTPUT_RENDER_CONFIG_EVENT,
  OUTPUT_STATE_EVENT,
  defaultRenderConfig,
  type OutputGlobeState,
  type OutputMode,
  type OutputRenderConfig,
  type OutputStateMessage,
} from '../services/multiOutput/protocol'
import { logger } from '../utils/logger'

/**
 * The geometry this window renders.
 *
 * A constant because v1 ships one mode, and it is deliberately *not*
 * read from the first `view.mode` that arrives: an output that adopted
 * the mode it was sent could never disagree with it, which would make
 * the check below vacuous. The mode has to be known independently for
 * the comparison to mean anything.
 *
 * When a second mode lands, the manager tells the window which it is —
 * the entry URL it is spawned with is the obvious carrier, since
 * `spawn()` already passes one and the output reads it before any IPC
 * exists.
 */
export const OUTPUT_MODE: OutputMode = 'sos-equirect'

/** Top-level keys of the mirrored state. */
export type StateKey = keyof OutputGlobeState

/** The platform surface, injectable so the link tests without Tauri. */
export interface OutputLinkHost {
  /** This window's label — `output-N`, minted by the manager. The
   *  manager routes on it, and an event without it is unattributable
   *  and gets dropped. */
  label: string
  /** The monitor this window actually landed on, so the manager can
   *  check it against the config it spawned from. `null` when the
   *  platform will not say. */
  monitorName(): Promise<string | null>
  listen(event: string, handler: (payload: unknown) => void): Promise<() => void>
  emit(event: string, payload: unknown): Promise<void>
  /**
   * Called when this window is *about* to close — Alt+F4, a window
   * manager's close button, the title bar an operator got back with
   * F11 — with a chance to speak before it goes (rung 13).
   *
   * This is the only thing that separates an operator closing an output
   * by hand from that output crashing. The manager classifies a destroy
   * it did not ask for as a crash unless an `output_closing` arrived
   * first, because a killed process cannot report its own death — so
   * without this hook every deliberate close is logged as a crash, and
   * three of them in a minute blocklist a perfectly good monitor.
   *
   * Optional, and its absence degrades exactly that far: the link still
   * works, closes are merely misread. That is the right failure for a
   * host that has no such notion (the static fixture page has none).
   */
  onCloseRequested?(handler: () => void): Promise<void>
}

/** What one accepted (or rejected) message did to the held state. */
export interface AcceptResult {
  /** False when the message was dropped as stale. */
  applied: boolean
  /** Keys whose value actually differs from what was held. Empty on a
   *  heartbeat snapshot that changed nothing — which is most of them. */
  changed: StateKey[]
}

export interface OutputStateStore {
  state(): Readonly<OutputGlobeState>
  /** The highest sequence number applied. */
  seq(): number
  accept(msg: OutputStateMessage): AcceptResult
}

/**
 * The state an output holds before the manager has said anything.
 *
 * `dayNight: true` matches the control globe's own default, so an
 * output that opens while the operator is on a fresh app shows the same
 * Earth rather than a flat-lit one corrected by the first diff.
 *
 * The view params are `IDENTITY_PARAMS` — the shader's own object,
 * reused rather than restated. That is the structural identity between
 * `MirroredEquirectParams` and `EquirectParams` paying off at the first
 * call site: no adapter, and no second place for the centred-camera
 * identity to be written down.
 */
export function outputInitialState(mode: OutputMode = OUTPUT_MODE): OutputGlobeState {
  return {
    dataset: null,
    primary: null,
    playback: null,
    display: null,
    layers: [],
    simulationDate: null,
    view: {
      mode,
      dayNight: true,
      // Copied, not aliased: `IDENTITY_PARAMS` is module-scoped and a
      // later in-place write would edit the shader's own constant.
      params: { cameraOffset: { ...IDENTITY_PARAMS.cameraOffset }, split: IDENTITY_PARAMS.split },
    },
  }
}

/**
 * Every key an output applies, exported so a consumer can ask for "all
 * of it" — which is what applying the state held at subscribe time
 * needs, and what keeps a key added to the schema from being applied
 * on diffs but skipped on the initial pass.
 */
export const STATE_KEYS: readonly StateKey[] = [
  'dataset',
  'primary',
  'playback',
  'display',
  'layers',
  'simulationDate',
  'view',
] as const satisfies readonly StateKey[]

/** Compile-time proof the list above is exhaustive — the same guard
 *  `stateAggregator` documents, for the same reason: a key added to the
 *  schema and not listed here is one the output silently never applies,
 *  which reads as "that setting takes a moment" rather than as a bug. */
type AssertNoneMissing<T extends never> = T
type _StateKeysAreExhaustive = AssertNoneMissing<
  Exclude<keyof OutputGlobeState, (typeof STATE_KEYS)[number]>
>

/**
 * The keys whose change can put a different pixel on the glass.
 *
 * Everything the output composites: the dataset's own media, the
 * operator's palette, the stacked layers, the camera and illumination,
 * and the simulation clock the sun will one day be read from. `layers`
 * and `simulationDate` are listed even though nothing composites them
 * yet — a key that arrives wired but unlisted would be applied and then
 * held back by the 1 Hz static floor, which reads as "that setting
 * takes a moment" rather than as a bug.
 */
export const PICTURE_KEYS = [
  'dataset',
  'display',
  'layers',
  'simulationDate',
  'view',
] as const satisfies readonly StateKey[]

/**
 * The keys read only by the playhead correction.
 *
 * These two describe where the *control window's* video is, and they
 * change on every frame the operator's globe plays — sixty diffs a
 * second, each one previously worth a redraw of a 4096x2048
 * ray-marched sphere. Neither one changes a pixel here. What this
 * output shows moves when its own decoder advances, which
 * `contentKindFor` already paces at 30 fps, or when the correction
 * seeks, which the render loop notices by comparing `currentTime`
 * across the call. Redrawing on the diff as well doubled the output's
 * GPU load for the exact content the 30 fps cap exists to bound — on a
 * machine whose webview may be on the iGPU, and whose control window is
 * decoding the same video in the next process.
 */
export const PLAYHEAD_KEYS = ['primary', 'playback'] as const satisfies readonly StateKey[]

/** Compile-time proof the two lists above partition `StateKey`: every
 *  key is classified, and none is classified twice. A key added to the
 *  schema and left out of both would silently never earn a frame. */
type _EveryKeyIsClassified = AssertNoneMissing<
  Exclude<StateKey, (typeof PICTURE_KEYS)[number] | (typeof PLAYHEAD_KEYS)[number]>
>
type _NoKeyIsClassifiedTwice = AssertNoneMissing<
  Extract<(typeof PICTURE_KEYS)[number], (typeof PLAYHEAD_KEYS)[number]>
>

/**
 * Did this diff change anything the output draws?
 *
 * Exported as a predicate rather than leaving the call site to test the
 * list, because the answer decides whether a frame is drawn and the
 * wrong answer is invisible in both directions: too eager burns a GPU
 * budget silently, too lazy leaves a stale picture that looks like a
 * dropped upload.
 */
export function changesPicture(changed: readonly StateKey[]): boolean {
  const picture: readonly StateKey[] = PICTURE_KEYS
  return changed.some(key => picture.includes(key))
}

export function createOutputStateStore(mode: OutputMode = OUTPUT_MODE): OutputStateStore {
  let held = outputInitialState(mode)
  let seq = -1

  return {
    state: () => held,
    seq: () => seq,
    accept(msg) {
      // A diff is only worth anything if it is newer than what we hold;
      // a snapshot is worth applying whatever its `seq` (heartbeat
      // resync at the same number, manager restart at a lower one).
      if (!msg.full && msg.seq <= seq) return { applied: false, changed: [] }

      const patch = msg.state as Partial<OutputGlobeState>
      const next = { ...held }
      const changed: StateKey[] = []

      for (const key of STATE_KEYS) {
        const incoming = patch[key]
        // Absent from a diff means "unchanged", not "clear". A full
        // snapshot always carries every key, so nothing is skipped
        // there; a malformed one that does not simply keeps what we
        // have, which beats blanking the sphere.
        if (incoming === undefined) continue
        if (key === 'view' && !acceptView(incoming as OutputGlobeState['view'], mode)) continue
        if (sameValue(held[key], incoming)) continue
        // Assigning through a per-key narrow rather than one cast of the
        // whole object, so a key whose type stops matching fails here.
        assignKey(next, key, incoming)
        changed.push(key)
      }

      held = next
      seq = msg.seq
      return { applied: true, changed }
    },
  }
}

/**
 * Whether a view arm belongs to the geometry this window renders.
 *
 * `view.mode` disagreeing with our own is a real fault — a window that
 * booted as one geometry being driven as another — and it is now
 * detectable rather than something that simply renders wrongly. The
 * response is to drop the *view* and keep everything else in the
 * message: the rest of the state is geometry-independent, so an output
 * that goes on showing the right dataset under its last good projection
 * is strictly better than one that applies a projection it cannot
 * render, or one that blanks.
 */
function acceptView(view: OutputGlobeState['view'], mode: OutputMode): boolean {
  if (view.mode === mode) return true
  logger.error(
    `[output] ignoring a '${view.mode}' view — this window renders '${mode}'. ` +
      'The manager and this window disagree about its geometry.',
  )
  return false
}

function assignKey<K extends StateKey>(
  target: OutputGlobeState,
  key: K,
  value: OutputGlobeState[K],
): void {
  target[key] = value
}

/**
 * Not every payload arriving on the channel is a state message.
 *
 * The output's capability grants a broad `listen`, and a malformed
 * payload must cost one dropped message rather than an exception
 * escaping into whatever the render loop was doing. Fail-closed, the
 * same posture `outputPersistence` takes on a blob it cannot parse.
 */
export function isStateMessage(payload: unknown): payload is OutputStateMessage {
  if (typeof payload !== 'object' || payload === null) return false
  const m = payload as Record<string, unknown>
  return (
    typeof m.seq === 'number' &&
    Number.isFinite(m.seq) &&
    typeof m.full === 'boolean' &&
    typeof m.state === 'object' &&
    m.state !== null
  )
}

/**
 * Not every payload on the config channel is a config.
 *
 * Same posture as `isStateMessage`: a malformed payload costs one
 * dropped message, never an exception out of the IPC callback. Each
 * field is checked independently so a message carrying one valid half
 * is not thrown away for the other.
 */
export function isRenderConfig(payload: unknown): payload is OutputRenderConfig {
  if (typeof payload !== 'object' || payload === null) return false
  const m = payload as Record<string, unknown>
  return (
    typeof m.framebufferWidth === 'number' &&
    Number.isFinite(m.framebufferWidth) &&
    typeof m.debugOverlay === 'boolean'
  )
}

export interface OutputLink {
  state(): Readonly<OutputGlobeState>
  /** The window configuration currently in force. */
  renderConfig(): Readonly<OutputRenderConfig>
  /** Called when the manager changes this window's configuration.
   *  Unlike state, there is no diffing here — a setting's latest value
   *  is the only one that matters, so every message is delivered. */
  onRenderConfig(listener: (config: Readonly<OutputRenderConfig>) => void): () => void
  /** Called after each accepted message that changed something, with
   *  the keys that differ. Never called with an empty list — a
   *  heartbeat that changed nothing is not news. */
  onChange(listener: (changed: StateKey[], state: Readonly<OutputGlobeState>) => void): () => void
  /** Detach the listener. Idempotent. */
  stop(): Promise<void>
}

/**
 * Install the listener, announce this window, and start folding state.
 *
 * The order is the point — see the module header.
 */
export async function connectOutputLink(
  host: OutputLinkHost,
  mode: OutputMode = OUTPUT_MODE,
): Promise<OutputLink> {
  const store = createOutputStateStore(mode)
  const listeners = new Set<(changed: StateKey[], state: Readonly<OutputGlobeState>) => void>()
  const configListeners = new Set<(config: Readonly<OutputRenderConfig>) => void>()
  let currentConfig = defaultRenderConfig()

  const unlisten = await host.listen(OUTPUT_STATE_EVENT, payload => {
    if (!isStateMessage(payload)) {
      logger.warn('[output] dropping a payload that is not a state message')
      return
    }
    const { applied, changed } = store.accept(payload)
    if (!applied || changed.length === 0) return
    for (const listener of listeners) {
      // Isolated: one listener throwing must not stop the others from
      // seeing a dataset change, and must not unwind into the IPC
      // callback, where it would surface as an unhandled rejection in a
      // window nobody is looking at.
      try {
        listener(changed, store.state())
      } catch (err) {
        logger.error('[output] state listener threw:', err)
      }
    }
  })

  const unlistenConfig = await host.listen(OUTPUT_RENDER_CONFIG_EVENT, payload => {
    if (!isRenderConfig(payload)) {
      logger.warn('[output] dropping a payload that is not a config message')
      return
    }
    currentConfig = payload
    for (const listener of configListeners) {
      try {
        listener(currentConfig)
      } catch (err) {
        logger.error('[output] config listener threw:', err)
      }
    }
  })

  // Announce the close before announcing readiness, so a window torn
  // down during a slow boot still says so. `emit` is fired and not
  // awaited: the window is closing underneath it and there is no later
  // point at which awaiting could help — the manager either receives it
  // before the destroy or classifies a crash, which is the documented
  // failure direction.
  await host.onCloseRequested?.(() => {
    void host
      .emit(OUTPUT_EVENT, { type: 'output_closing', label: host.label })
      .catch(err => logger.warn('[output] could not announce the close:', err))
  })

  // After both listeners, never before: the manager answers this by
  // sending the first full snapshot and this window's config straight
  // away.
  await host.emit(OUTPUT_EVENT, {
    type: 'output_ready',
    label: host.label,
    monitorName: await host.monitorName(),
    mode,
  })

  let stopped = false
  return {
    state: () => store.state(),
    renderConfig: () => currentConfig,
    onRenderConfig(listener) {
      configListeners.add(listener)
      return () => configListeners.delete(listener)
    },
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async stop() {
      if (stopped) return
      stopped = true
      listeners.clear()
      configListeners.clear()
      unlisten()
      unlistenConfig()
    },
  }
}

/**
 * The real host, and the only Tauri importer in this module.
 *
 * Dynamic imports for the same reason the manager's `createTauriHost`
 * uses them: the modules that matter here stay testable without a
 * packaged build, and the static fixture page that renders
 * `output.html` in a browser can load this file without a Tauri global
 * existing.
 *
 * Every capability it needs is granted by `capabilities/output.json` —
 * `core:event:allow-listen` / `allow-emit` for the channel and
 * `core:window:allow-current-monitor` for the placement check. `label`
 * needs no grant: it is a property Tauri sets on the window object,
 * not a command.
 */
export async function createTauriLinkHost(): Promise<OutputLinkHost> {
  const [windowApi, eventApi] = await Promise.all([
    import('@tauri-apps/api/window'),
    import('@tauri-apps/api/event'),
  ])
  const self = windowApi.getCurrentWindow()

  return {
    label: self.label,
    async monitorName() {
      // Best-effort. The manager uses this only to check the window
      // landed where it was placed, so losing it costs that check —
      // not the link, which is the whole reason the output exists.
      try {
        return (await windowApi.currentMonitor())?.name ?? null
      } catch (err) {
        logger.warn('[output] could not read the current monitor:', err)
        return null
      }
    },
    async listen(event, handler) {
      return eventApi.listen(event, e => handler(e.payload))
    },
    async emit(event, payload) {
      await eventApi.emit(event, payload)
    },
    async onCloseRequested(handler) {
      // Deliberately not `preventDefault()`-ing the close. The operator
      // asked for this window to go and it goes; the announcement is a
      // courtesy to the manager, not a veto, and a hook that could
      // block would be a hook that can strand an undecorated window.
      await self.onCloseRequested(() => handler())
    },
  }
}
