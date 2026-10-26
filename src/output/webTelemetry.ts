// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * What the output page reports about itself in web mode
 * (`docs/SECOND_LIFE_COMPAT.md` §7). A desktop output window reports
 * nothing of its own; its control window does (`outputTelemetry.ts`).
 * On the web there is no control window, so the page reports for
 * itself, and only two things:
 *
 * - **`layer_loaded` with `trigger: 'output'`** when a dataset reaches
 *   the glass. `layer_id` is the id the node returned for the record,
 *   never the text of the address (`webDataset` refuses a record with
 *   none).
 * - **`error` with `category: 'output'`**: a dataset that would not show,
 *   and the fatal errors its stream reports, recovered or not. `code`
 *   says which (`WebOutputErrorCode`). The message is fixed text per
 *   code or the player's own error name, and the stack is dropped, so no
 *   Research-tier `error_detail` follows and the address's text never
 *   reaches the wire. An hls.js stream that will not load reports both:
 *   `stream` rows for its fatal errors, then one `media` row for the
 *   dataset. A native-HLS or single-file one reports only the `media`
 *   row, since those report a stream only once it has loaded.
 *
 * **Only in the first minute after the page loads**
 * (`WEB_OUTPUT_REPORT_WINDOW_MS`, page time), and **nothing sent after
 * it** (`deadlineTransport`: no retry past the deadline, no beacon as
 * the page closes). A page keeps running for as long as its visitor
 * stays in range, so a row from later in a visit, or a batch retried
 * after an outage, would show how long someone stood near the globe, and
 * copies reporting the same change together would show who stood there
 * together. Page time, not when telemetry turned on, so a late
 * `#telemetry=1` reports nothing rather than opening a minute on every
 * copy in range at once. A change before the `#` reloads the page and
 * starts a new minute, so owners of a measured globe should steer it
 * after the `#` (`EMBED_URL_GRAMMAR.md`). **No
 * session event at all**: `session_start` would put the visitor's
 * locale, OS and screen beside the moment they arrived, which is the
 * match a land owner's log of avatar arrivals invites. Visitors are
 * still countable, as the distinct session ids on these rows.
 *
 * **Off unless the globe's owner turns it on** with `telemetry=1`
 * (`webMode.ts`), followed live by `webOutput`, and never with Global
 * Privacy Control set. The page loads for everyone in range of a globe
 * with no notice, and anyone can point a globe at a public node, so
 * only a globe someone chose to measure reports. Both rules are the
 * maintainer's decisions of 24 October 2026, after the privacy review.
 * Every event is Essential (Tier A) and goes through the app's emitter,
 * so the kill switch and a stored Off for the same site in the same
 * browser apply. A Second Life viewer keeps its own browser, so there
 * the app's setting never reaches it.
 *
 * Loaded through a dynamic import, and only once an address turns it on,
 * so a desktop output window loads no telemetry code at all.
 */

import {
  BATCH_INTERVAL_MS,
  TELEMETRY_BUILD_ENABLED,
  TELEMETRY_CONSOLE_MODE,
  createFetchTransport,
  emit,
  reportError,
  setTransport,
  type SendResult,
  type Transport,
} from '../analytics'
import { WebDatasetError, type WebDatasetFailure } from './webDataset'
import type { MirroredDataset } from '../services/multiOutput/protocol'

/** How long after the page loads it reports anything: page time, from
 *  `performance.now()`, so an address that turns telemetry on later in a
 *  visit reports nothing, rather than opening a fresh minute on every
 *  copy in range at once. */
export const WEB_OUTPUT_REPORT_WINDOW_MS = 60_000

/** The last moment, in page time, the page sends anything: the window,
 *  one batch interval for its last event to go, and a second's margin.
 *  After it a batch is dropped, not retried, so an outage cannot deliver
 *  first-minute rows minutes later and prove the page was still open. */
export const WEB_OUTPUT_SEND_DEADLINE_MS = WEB_OUTPUT_REPORT_WINDOW_MS + BATCH_INTERVAL_MS + 1_000

const DROPPED: SendResult = { status: null, ok: false, retryable: false, permanent: true }

/**
 * A transport that sends nothing after `deadlineMs` of page time, and
 * never by beacon. After the deadline a send reports `permanent`, which
 * the emitter treats as the kill switch: it stops and drops its queue.
 * The beacon is what the emitter fires as the page closes, with whatever
 * is still queued, and on a globe that would date the visitor's leaving;
 * it claims success and sends nothing, so those last rows are lost.
 */
export function deadlineTransport(inner: Transport, deadlineMs: number, nowMs: () => number): Transport {
  return {
    endpoint: inner.endpoint,
    send: (sessionId, events) => (nowMs() < deadlineMs ? inner.send(sessionId, events) : Promise.resolve(DROPPED)),
    sendBeacon: () => true,
  }
}

/** The most `layer_loaded` events a copy sends in its one minute,
 *  because a script cycling a globe's address sets that rate, not a
 *  visitor. */
export const WEB_OUTPUT_LAYER_LOADED_MAX_PER_MINUTE = 30

/** Why the page reports an error: what fetching the dataset found
 *  (`WebDatasetFailure`, the network included), a picture or stream that
 *  would not load, or a fatal error from a stream. */
export type WebOutputErrorCode = WebDatasetFailure | 'media' | 'stream'

/** Which code a failure to show a dataset reports under. Anything that
 *  is not a `WebDatasetError` happened after the record arrived: the
 *  media would not load. */
export function webOutputErrorCode(err: unknown): Exclude<WebOutputErrorCode, 'stream'> {
  return err instanceof WebDatasetError ? err.failure : 'media'
}

export interface WebTelemetry {
  /** A dataset reached the glass, `loadMs` after it was asked for. */
  datasetShown(dataset: MirroredDataset, loadMs: number): void
  /** A dataset would not show. Called on the first failure of each
   *  attempt to show one, not on its retries. */
  datasetFailed(err: unknown): void
  /** A fatal error from the stream, whether or not hls.js recovers. */
  streamError(err: Error): void
}

export interface WebTelemetryDeps {
  /** Page time in milliseconds (`performance.now()`), for the window. */
  nowMs?: () => number
  /** Install the transport. Replaced in tests. */
  start?: () => void
  /** Whether the browser asks sites not to track it. */
  globalPrivacyControl?: () => boolean
}

function startForReal(): void {
  // As in the app: no transport in a telemetry-free build, and none in
  // console mode, where batches are logged rather than sent.
  if (TELEMETRY_BUILD_ENABLED && !TELEMETRY_CONSOLE_MODE) {
    setTransport(deadlineTransport(createFetchTransport(), WEB_OUTPUT_SEND_DEADLINE_MS, () => performance.now()))
  }
}

function browserGpc(): boolean {
  return typeof navigator !== 'undefined' && (navigator as { globalPrivacyControl?: boolean }).globalPrivacyControl === true
}

/** An error to report with `code` and `message` and no stack. Without
 *  a stack `reportError` sends no Research-tier `error_detail`, whose
 *  frames would be this page's own and say nothing. */
function reportable(message: string, code: WebOutputErrorCode): Error {
  const err = Object.assign(new Error(message), { code })
  err.stack = ''
  return err
}

/** Start the page's telemetry, or `null` when the browser has Global
 *  Privacy Control set. */
export function startWebTelemetry(deps: WebTelemetryDeps = {}): WebTelemetry | null {
  if ((deps.globalPrivacyControl ?? browserGpc)()) return null
  const nowMs = deps.nowMs ?? (() => performance.now())
  ;(deps.start ?? startForReal)()
  const open = (): boolean => nowMs() < WEB_OUTPUT_REPORT_WINDOW_MS
  let shown = 0

  return {
    datasetShown(dataset, loadMs) {
      if (!open() || shown >= WEB_OUTPUT_LAYER_LOADED_MAX_PER_MINUTE) return
      shown++
      emit({
        event_type: 'layer_loaded',
        layer_id: dataset.id,
        // `hls` for any video, its single-file fallback included, as the
        // app reports it (`main.ts`'s `emitLayerLoaded`).
        layer_source: dataset.kind === 'video' ? 'hls' : 'image',
        slot_index: '0',
        trigger: 'output',
        load_ms: Math.max(0, Math.round(loadMs)),
      })
    },
    datasetFailed(err) {
      if (!open()) return
      // A fixed message: a dataset error's own names what the address
      // asked for.
      const code = webOutputErrorCode(err)
      reportError('output', reportable(`output ${code}`, code))
    },
    streamError(err) {
      if (!open()) return
      // hls.js's error names (`networkError: fragLoadError`), or the
      // native and single-file paths' fixed ones (`native:
      // nativeHlsError`, `progressive: mp4ErrorAfterLoad`): no URL, no
      // dataset id.
      reportError('output', reportable(err.message, 'stream'))
    },
  }
}
