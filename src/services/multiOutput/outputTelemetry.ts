// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * What the control window reports about its output windows
 * (`docs/MULTI_MONITOR_PLAN.md` §3 "Failure recovery" and Open
 * Question 3 — decided; rung 13).
 *
 * Three Tier A events, and one rule about who sends them: **the
 * control window does, the outputs never do.** §3.6's capture-clean
 * policy exists because the common installation pattern is an HDMI
 * capture card taking a monitor as its input, so everything an output
 * window does ends up on a physical sphere in front of an audience. An
 * output that phoned home would be that leak one layer down, and it
 * would buy nothing: the manager already sees every fact worth
 * reporting, and the two failures an output could report about itself
 * are exactly the two it cannot (a crashed process sends nothing, and
 * a window whose IPC went silent has no channel left to say so on).
 *
 * ## Why this is not three `emit()` calls in the manager
 *
 * Two of the three fields that go on the wire are *projections* with a
 * wrong answer available — a framebuffer width has to become a bucket,
 * and a departure has to become a reason — and the manager is nine
 * hundred lines with nowhere to test them. Same split as
 * `outputHealth.ts`, whose `OutputDeparture` is this module's input:
 * that one decides *what happened*, this one decides *what to say
 * about it*. Keeping them apart is what lets the classification stay
 * free of any opinion about a telemetry schema.
 *
 * The reporters are here rather than at the call sites for the reason
 * cases 2-5 will make obvious: `output_failure` gets five detectors
 * across two files, and five hand-written event literals is five
 * chances to omit `retries` or invert `recovered`.
 *
 * ## Not throttled, and that is a decision rather than an omission
 *
 * `docs/ANALYTICS_CONTRIBUTING.md` asks for a throttle on anything
 * that can fire more than ~30/min. Every event here is one discrete
 * operator action or one window departure, so the ordinary rate is a
 * handful per session — the same class as `browse_opened` or
 * `settings_changed`, neither of which is throttled either. The one
 * path that could repeat is an operator clicking Add at a monitor the
 * storm guard has blocked, since each refusal reports. That is
 * click-bounded rather than programmatic, and a burst of
 * `rejected-by-storm-guard` on one monitor is not noise: it says a
 * display is broken and somebody is fighting it, which is exactly what
 * the reason exists to surface.
 *
 * ## Nothing here needs hashing, sanitising or rounding
 *
 * Every field is a small closed enum or a count. The two that could
 * have identified a machine do not: the framebuffer is a rung name
 * rather than a pixel count, and the monitor is an index into the
 * enumeration rather than the OS-reported display name — which is a
 * user-set string on macOS and a panel model number on plenty of
 * Windows boxes. See `docs/ANALYTICS_CONTRIBUTING.md`'s reviewer
 * checklist; this module is the whole surface it applies to.
 */

import { emit } from '../../analytics'
import { logger } from '../../utils/logger'
import type {
  FramebufferBucket,
  OutputFailureKind,
  OutputRemovedReason,
} from '../../types'

import type { OutputDeparture } from './outputHealth'
import { FRAMEBUFFER_WIDTHS, type FramebufferWidth, type OutputMode } from './protocol'

/**
 * Rung → bucket, as an exhaustive record rather than a `switch`.
 *
 * Typing it `Record<FramebufferWidth, …>` is the point: adding a rung
 * to `FRAMEBUFFER_WIDTHS` fails to compile here until someone decides
 * what to call it, instead of silently reporting the new rung as
 * whichever neighbour a `default` branch picked.
 */
const BUCKET_FOR_RUNG: Record<FramebufferWidth, FramebufferBucket> = {
  1024: '1k',
  2048: '2k',
  4096: '4k',
  8192: '8k',
}

/**
 * The bucket an output at this framebuffer width is actually running.
 *
 * Snapped **down** to a rung, which is not a rounding preference but
 * the same rule `outputScene.setFramebufferWidth` applies — it snaps
 * down because overshooting spends GPU memory on hardware that
 * reported less. Reporting the nearest rung instead would tell a
 * dashboard an installation runs 8K when its window is rendering 4K.
 *
 * A width below the floor, or one that is not a number at all, reports
 * the smallest rung, because that is what the scene renders it as.
 */
export function framebufferBucket(width: number): FramebufferBucket {
  // Sorted rather than assumed ascending: the ladder is a const tuple
  // today, and a future rung inserted in the middle of it should not
  // quietly change what this answers.
  const rungs = [...FRAMEBUFFER_WIDTHS].sort((a, b) => a - b)
  let rung: FramebufferWidth = rungs[0]
  for (const candidate of rungs) {
    if (width >= candidate) rung = candidate
  }
  return BUCKET_FOR_RUNG[rung]
}

/**
 * A departure, as the reason a dashboard reads.
 *
 * `removed` and `closed` both report `operator-close`, and collapsing
 * them is deliberate. The manager has to keep them apart — one is its
 * own `close()` completing and must not touch `records`, the other is
 * a window that went away behind its back — but to anyone reading a
 * dashboard they are one thing: a person decided this output should
 * stop. Splitting them would put the manager's internal bookkeeping
 * into a published schema, where the interesting split is
 * deliberate-versus-not and it is already there.
 */
export function removalReasonFor(departure: OutputDeparture): OutputRemovedReason {
  switch (departure) {
    case 'crashed':
      return 'crash'
    case 'removed':
    case 'closed':
      return 'operator-close'
    default: {
      // Exhaustiveness proof: a fourth departure kind has to decide
      // what it is called on the wire before it compiles.
      const unreachable: never = departure
      return unreachable
    }
  }
}

/**
 * `emit`, but it cannot take the manager down with it.
 *
 * Every reporter here is called from the middle of the manager's own
 * bookkeeping — between deleting a record and persisting it, between
 * registering a window and returning it — and `emit` reaches
 * `loadConfig()` (localStorage, which private-mode Safari has and
 * throws on) and, once a batch fills, a transport. A throw there would
 * skip the `persist()` that follows it, leaving an output gone from
 * memory and still in the config, back on the next launch. Reporting
 * an installation's health must never be able to change it; the same
 * rule `notifyChange` follows for panel listeners.
 */
function report(event: Parameters<typeof emit>[0]): void {
  try {
    emit(event)
  } catch (err) {
    logger.warn(`[multiOutput] could not report ${event.event_type}:`, err)
  }
}

/** One output window came up. Fires for a restore exactly as it does
 *  for an operator's Add — the event describes an output existing, and
 *  the manager spawns both through one function on purpose. */
export function reportOutputAdded(output: {
  mode: OutputMode
  framebufferWidth: number
  monitorIndex: number
}): void {
  report({
    event_type: 'output_added',
    mode: output.mode,
    framebuffer_bucket: framebufferBucket(output.framebufferWidth),
    monitor_index: output.monitorIndex,
  })
}

/** One output window stopped running — or, for the storm guard, never
 *  started. */
export function reportOutputRemoved(output: {
  mode: OutputMode
  reason: OutputRemovedReason
}): void {
  report({
    event_type: 'output_removed',
    mode: output.mode,
    reason: output.reason,
  })
}

/**
 * One output failed.
 *
 * `retries` and `recovered` have no defaults on purpose. A detector
 * that does not attempt recovery passes `0` and `false` explicitly,
 * which is one word of thought at the call site and the difference
 * between a dashboard that means something and one where every
 * failure claims zero retries because nobody filled the field in.
 */
export function reportOutputFailure(failure: {
  kind: OutputFailureKind
  retries: number
  recovered: boolean
}): void {
  report({
    event_type: 'output_failure',
    kind: failure.kind,
    retries: failure.retries,
    recovered: failure.recovered,
  })
}
