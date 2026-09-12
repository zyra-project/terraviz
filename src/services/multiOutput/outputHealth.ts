// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Why an output window went away, and when to stop putting new ones on
 * a monitor (`docs/MULTI_MONITOR_PLAN.md` §3 "Failure recovery",
 * cases 1 and 6; rung 13).
 *
 * Until this landed the manager *recorded* output events and acted on
 * none of them: `lastEvent` was written and read by nobody, so a
 * crashed output stayed in `records` forever, kept receiving diffs it
 * could not apply, and still counted against the decoder budget. An
 * operator who closed an output by hand got the same — the panel went
 * on listing a window that was not there.
 *
 * Pure, and separate from the manager for the reason `stateAggregator`
 * is: the decisions here have wrong answers, and none of them needs a
 * window to reach. No DOM, no Tauri, no timers — the guard reads its
 * clock through an injected `nowMs`.
 *
 * ## Absence is the signal, and it errs one way on purpose
 *
 * A crash is a window that was destroyed having said nothing. There is
 * no positive evidence of a crash to wait for — a killed process sends
 * nothing by definition — so the classification is what *did not*
 * arrive, and any lost or late `output_closing` reads as a crash.
 *
 * That asymmetry is deliberate rather than tolerated. A crash misread
 * as a close is invisible: the record disappears, the operator is told
 * nothing, and an installation that is quietly dying looks tidy. A
 * close misread as a crash costs one wrong line in the panel and one
 * telemetry event with the wrong `reason`. The plan's whole policy for
 * this feature is "never auto-recover silently", and a detector that
 * fails toward silence would undo it.
 */

/**
 * Identity of a monitor, as a comparable string.
 *
 * Name **and** signed origin — the rule §3 "Persistence" states,
 * because a name alone is not an identity: Windows display names are
 * assigned positionally and reassigned across an unplug, replug or
 * driver update.
 *
 * **There is a second copy of this in `src/ui/outputUI.ts`, on
 * purpose.** The obvious fix — one shared definition — is the one thing
 * that cannot be done cheaply here: the panel needs it at *runtime*,
 * and every `multiOutput/` import in `outputUI.ts` is type-only because
 * `main.ts` loads that panel eagerly, so a value import from any module
 * in this directory that itself imports anything would drag the IPC
 * contract back into the web entry chunk. That regression shipped once
 * and is invisible to the grep that polices Tauri leakage. Two three-
 * line copies of a template string is the cheaper risk than a rule
 * whose violations do not announce themselves, so both sides name each
 * other and a change to either has to be made twice, deliberately.
 *
 * `matchMonitorIndex` in `outputPersistence` is a third encoding of the
 * same rule and stays its own function for a better reason: it compares
 * a *persisted* record, parsed from disk with differently named fields,
 * against a live enumeration.
 */
export function monitorKeyOf(monitor: {
  name: string | null
  position: { x: number; y: number }
}): string {
  return `${monitor.name ?? ''}@${monitor.position.x},${monitor.position.y}`
}

/** What happened to a window that is no longer there. */
export type OutputDeparture =
  /** The manager closed it — the operator used Remove, or `closeAll()`
   *  ran. Expected, and not worth telling anyone about. */
  | 'removed'
  /** The window closed itself and said so first: Alt+F4, a window
   *  manager's close button, or the operator reaching an output they
   *  had taken out of fullscreen with F11. */
  | 'closed'
  /** Destroyed with no warning. A webview process kill, a driver
   *  taking the window down, an OOM. */
  | 'crashed'

export interface DepartureSignals {
  /** The manager asked for this close and is expecting the destroy. */
  managerInitiated: boolean
  /** An `output_closing` event arrived from this output before it
   *  went. */
  sawClosing: boolean
}

/**
 * Read a departure from the two things that can precede it.
 *
 * `managerInitiated` wins over `sawClosing` rather than being checked
 * after it, and that ordering is load-bearing: an operator clicking
 * Remove in the panel makes the manager call `close()`, which fires the
 * output's own close-requested handler, which emits `output_closing`.
 * Both flags are then true for the *same* departure. Reporting that as
 * an operator closing the window by hand would be wrong in the one case
 * the panel already knows the answer to.
 */
export function classifyDeparture(signals: DepartureSignals): OutputDeparture {
  if (signals.managerInitiated) return 'removed'
  return signals.sawClosing ? 'closed' : 'crashed'
}

/** Crashes on one monitor within `CRASH_STORM_WINDOW_MS` that trip the
 *  guard. The plan's number. */
export const CRASH_STORM_LIMIT = 3

/** How close together those crashes have to be to count as a storm. */
export const CRASH_STORM_WINDOW_MS = 60_000

export interface CrashStormGuard {
  /** Count one crash against a monitor. */
  record(monitorKey: string): void
  /** Whether this monitor is refusing new outputs for the session. */
  isBlocked(monitorKey: string): boolean
  /** Monitors currently blocked, for the panel's message. */
  blocked(): string[]
}

/**
 * Stop respawning outputs onto a monitor that keeps killing them.
 *
 * Three crashes inside a minute is not bad luck; it is a driver, a
 * cable or a display that cannot hold a fullscreen GPU surface. Without
 * this an operator watching a black projector re-adds the output, it
 * dies, they re-add it — and the loop hides the fact that the *monitor*
 * is the problem.
 *
 * ## The window detects the storm; the block does not expire
 *
 * These are two different durations and conflating them is the easy
 * mistake. `CRASH_STORM_WINDOW_MS` decides whether three crashes were
 * *a storm* — three spread over an afternoon are three unrelated
 * incidents and must not trip it. But once tripped the monitor stays
 * refused for the rest of the session, because nothing observed since
 * suggests the hardware got better; the plan says so outright, and an
 * expiring block would put the operator straight back into the retry
 * loop this exists to break.
 *
 * ## It is never persisted
 *
 * The counter resets at next launch, deliberately. A block written to
 * disk would outlive the reseated cable that fixed it, and the operator
 * would have no way to tell a refusing monitor from a broken feature.
 * Relaunching is the reset, and it is a reset an operator can reach
 * without being told about it.
 *
 * Keyed by `monitorKey` — name **and** signed origin, the identity rung
 * 10's restore matching uses — rather than by index, because an unplug
 * and replug renumbers the enumeration and would move the block to
 * whichever display took the index.
 */
export function createCrashStormGuard(
  options: {
    nowMs?: () => number
    limit?: number
    windowMs?: number
  } = {},
): CrashStormGuard {
  const now = options.nowMs ?? (() => Date.now())
  const limit = options.limit ?? CRASH_STORM_LIMIT
  const windowMs = options.windowMs ?? CRASH_STORM_WINDOW_MS
  /** Crash timestamps per monitor, pruned to the window on each write. */
  const recent = new Map<string, number[]>()
  const blocked = new Set<string>()

  return {
    record(monitorKey) {
      const at = now()
      // Pruned on write rather than on read: a session that runs for a
      // week must not accumulate a timestamp per crash forever, and
      // `isBlocked` is called far more often than this is.
      const times = (recent.get(monitorKey) ?? []).filter(t => at - t < windowMs)
      times.push(at)
      recent.set(monitorKey, times)
      if (times.length >= limit) {
        blocked.add(monitorKey)
        // The timestamps have done their job. Dropping them keeps the
        // map from holding a list that can never change the answer.
        recent.delete(monitorKey)
      }
    },
    isBlocked: monitorKey => blocked.has(monitorKey),
    blocked: () => [...blocked],
  }
}
