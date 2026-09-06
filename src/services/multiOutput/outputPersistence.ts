// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Persisted multi-monitor output configuration
 * (`docs/MULTI_MONITOR_PLAN.md` §3 "Persistence", delivery rung 10).
 *
 * Two jobs, kept in one module because they share a schema and nothing
 * else in the codebase needs either half:
 *
 * 1. **Storage.** Read and write `localStorage['sos-multi-output-config']`,
 *    fail-closed, behind a `StorageLike` seam so a test drives it without
 *    a browser and the manager never touches `localStorage` directly.
 * 2. **Monitor matching.** Decide whether a persisted output's monitor is
 *    still present — the rule with real correctness content, and the
 *    reason this is a module rather than a few lines inside the manager.
 *
 * **A name-only match is not a match.** Windows reports `\\.\DISPLAY1`,
 * `\\.\DISPLAY2`, `\\.\DISPLAY3` — names assigned *positionally* and
 * reassigned across an unplug, a replug or a driver update. Matching on
 * the name alone can restore an output onto a physically different
 * monitor while looking like it worked, and on an installation that is a
 * projector showing the wrong thing to an audience with nothing on
 * screen to say so. So a match requires the name **and** the signed
 * physical origin; anything less is a monitor we do not recognise, and
 * the entry is skipped and logged rather than guessed at. Restoring
 * nothing is a better failure than restoring the wrong monitor.
 *
 * Origins are stored **signed and as reported** — physical pixels,
 * negative `x` included, exactly as `availableMonitors()` gave them. A
 * value that has been through a logical conversion cannot be compared
 * against a fresh `Monitor.position` on a HiDPI desk, and nothing in the
 * placement path wants the converted form anyway.
 *
 * Pure apart from the injected storage: no DOM, no Tauri, no timers.
 */

import { logger } from '../../utils/logger'
import type { OutputMode } from './protocol'
import type { OutputMonitor } from './manager'
import type { OutputViewSettings } from './stateAggregator'

export const OUTPUT_CONFIG_STORAGE_KEY = 'sos-multi-output-config'

/**
 * Schema version.
 *
 * The plan's shape carries no version field. One is added here because
 * the alternative is a stored blob that can only ever be re-parsed
 * optimistically: a future incompatible change would have to guess
 * whether an unrecognised object is old, corrupt, or from a newer build
 * the user has since downgraded from. A mismatch resets to defaults —
 * losing an output list an operator can rebuild in three clicks, rather
 * than half-applying a shape nobody wrote.
 */
export const OUTPUT_CONFIG_VERSION = 1

/**
 * How long to wait between spawning restored outputs.
 *
 * The spike's one measurable cost was startup contention — sixteen
 * outputs took ~160 ms longer to reach full rate than eight — so
 * restores are paced rather than fired together. Steady state was
 * unaffected, which is why this is a spawn-time delay and not a budget.
 */
export const OUTPUT_RESTORE_STAGGER_MS = 250

/** One persisted output. */
export interface PersistedOutput {
  /**
   * The window label it had last time, reused on restore when free so
   * `output-1` keeps meaning the same display across launches — which
   * is what makes it worth anything in a log or a health badge.
   */
  label: string
  /** OS-reported name; matched **with** `monitorOrigin`, never alone.
   *  `null` when the platform reported none, which Linux does. */
  monitorName: string | null
  /** Physical pixels, **signed**, exactly as reported. */
  monitorOrigin: { x: number; y: number }
  mode: OutputMode
  trackOperatorCamera: boolean
  split: boolean
}

export interface PersistedOutputConfig {
  version: number
  outputs: PersistedOutput[]
  /** Opt-in, default false. Off means boot enumerates no monitors and
   *  opens no IPC link — the plan's "an install that never enabled
   *  outputs pays nothing". */
  autoRestoreOnLaunch: boolean
}

export function defaultOutputConfig(): PersistedOutputConfig {
  return { version: OUTPUT_CONFIG_VERSION, outputs: [], autoRestoreOnLaunch: false }
}

/** The slice of `localStorage` this module uses. Injectable so a test
 *  needs no browser, and so a caller can hand in a null store. */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** The store the manager persists through. */
export interface OutputConfigStore {
  read(): PersistedOutputConfig
  write(config: PersistedOutputConfig): void
}

function defaultStorage(): StorageLike | null {
  try {
    // Access, not just presence: Safari in private mode has the object
    // and throws on use, and a throw here would take out the app boot
    // that reads this.
    if (typeof localStorage === 'undefined') return null
    localStorage.getItem(OUTPUT_CONFIG_STORAGE_KEY)
    return localStorage
  } catch {
    return null
  }
}

/**
 * Parse a stored blob, fail-closed.
 *
 * Anything unrecognised — wrong version, bad JSON, a non-array
 * `outputs`, an entry missing its origin — resolves to defaults rather
 * than to a partially-trusted object. This blob drives *window spawning*
 * on a machine an operator may not be sitting at, so a half-understood
 * entry is not worth acting on. Individual malformed entries are dropped
 * and the rest kept, because losing one output to a schema slip should
 * not cost an installation the other three.
 */
export function parseOutputConfig(raw: string | null): PersistedOutputConfig {
  if (!raw) return defaultOutputConfig()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    logger.warn('[multiOutput] stored output config is not JSON; using defaults')
    return defaultOutputConfig()
  }
  if (!isRecord(parsed)) return defaultOutputConfig()
  if (parsed.version !== OUTPUT_CONFIG_VERSION) {
    logger.warn(
      `[multiOutput] stored output config is version ${String(parsed.version)}, ` +
        `expected ${OUTPUT_CONFIG_VERSION}; using defaults`,
    )
    return defaultOutputConfig()
  }
  const rawOutputs = Array.isArray(parsed.outputs) ? parsed.outputs : []
  const outputs: PersistedOutput[] = []
  for (const entry of rawOutputs) {
    const output = parseOutput(entry)
    if (output) outputs.push(output)
    else logger.warn('[multiOutput] dropping a malformed persisted output')
  }
  return {
    version: OUTPUT_CONFIG_VERSION,
    outputs,
    autoRestoreOnLaunch: parsed.autoRestoreOnLaunch === true,
  }
}

function parseOutput(entry: unknown): PersistedOutput | null {
  if (!isRecord(entry)) return null
  const { label, monitorName, monitorOrigin, mode } = entry
  if (typeof label !== 'string' || !label) return null
  if (monitorName !== null && typeof monitorName !== 'string') return null
  if (!isRecord(monitorOrigin)) return null
  const { x, y } = monitorOrigin
  // `Number.isFinite`, not `typeof === 'number'`: `NaN` round-trips
  // through JSON as `null` but a hand-edited file can carry one, and a
  // NaN origin compares unequal to itself, so it would silently never
  // match any monitor.
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  if (mode !== 'sos-equirect') return null
  return {
    label,
    monitorName,
    monitorOrigin: { x: x as number, y: y as number },
    mode,
    trackOperatorCamera: entry.trackOperatorCamera !== false,
    split: entry.split === true,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * A store over `localStorage`, or an inert one where it is unavailable.
 *
 * Inert rather than throwing: a private-mode browser or a locked-down
 * webview should cost the operator persistence, not the feature. Reads
 * return defaults, writes are dropped, and everything above this line
 * keeps working.
 */
export function createOutputConfigStore(
  storage: StorageLike | null = defaultStorage(),
): OutputConfigStore {
  return {
    read() {
      if (!storage) return defaultOutputConfig()
      try {
        return parseOutputConfig(storage.getItem(OUTPUT_CONFIG_STORAGE_KEY))
      } catch (err) {
        logger.warn('[multiOutput] could not read output config:', err)
        return defaultOutputConfig()
      }
    },
    write(config) {
      if (!storage) return
      try {
        storage.setItem(OUTPUT_CONFIG_STORAGE_KEY, JSON.stringify(config))
      } catch (err) {
        // Quota, private mode, or a storage partition change. The live
        // outputs are unaffected; only the next launch is.
        logger.warn('[multiOutput] could not persist output config:', err)
      }
    },
  }
}

/** Project a live output into its persisted form. */
export function toPersistedOutput(
  label: string,
  monitor: OutputMonitor,
  mode: OutputMode,
  view: OutputViewSettings,
): PersistedOutput {
  return {
    label,
    monitorName: monitor.name,
    // Copied, not referenced: the record's monitor object outlives this
    // call, and a stored alias would let a later mutation rewrite
    // history that has already been serialised once.
    monitorOrigin: { x: monitor.position.x, y: monitor.position.y },
    mode,
    trackOperatorCamera: view.trackCamera,
    split: view.split,
  }
}

/**
 * Index of the monitor a persisted output should be restored onto, or
 * `null` when none matches.
 *
 * Requires name **and** signed origin. See the module header for why a
 * name-only match is treated as no match at all.
 */
export function matchMonitorIndex(
  output: PersistedOutput,
  monitors: readonly OutputMonitor[],
): number | null {
  const index = monitors.findIndex(
    monitor =>
      monitor.name === output.monitorName &&
      monitor.position.x === output.monitorOrigin.x &&
      monitor.position.y === output.monitorOrigin.y,
  )
  return index === -1 ? null : index
}
