// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Operator-side telemetry emitter for the migration CLIs.
 *
 * Phase 3 commit C helper. The browser-based emitter in
 * `src/analytics/` runs in a session context (rotating session_id,
 * batched dispatch, pagehide flush). The migration CLI is a Node
 * process that runs once and exits — no session, no batching, no
 * pagehide.
 *
 * This helper POSTs each event individually to the same
 * `/api/ingest` endpoint the SPA uses. The session_id rotates per
 * migration run; events from a single run share one id so a
 * Grafana operator can correlate "this migration's progress"
 * without joining across runs.
 *
 * Event-type-agnostic on purpose. The migrate-r2-hls subcommand
 * (commit C) constructs `migration_r2_hls` events; commit E adds
 * that event_type string to the ingest endpoint's KNOWN_EVENT_TYPES
 * set. Until E lands the endpoint 400s the events with
 * `invalid_body`; the CLI's onWarn surfaces that as a soft warning
 * rather than aborting the migration.
 *
 * Origin header is stamped on every emit so the endpoint's
 * `isAllowedOrigin` same-origin check passes (Node fetch doesn't
 * set Origin by default; the same gotcha Phase 2 surfaced live
 * mid-migration).
 */

import { randomUUID } from 'node:crypto'

/**
 * Wire shape of an event payload. Whatever the caller constructs
 * here is JSON-encoded and posted in the `events[0]` slot of the
 * batch. `event_type` is the discriminator the ingest endpoint
 * validates against its KNOWN_EVENT_TYPES set; every other field
 * is event-specific.
 */
export interface TelemetryEventPayload {
  event_type: string
  [key: string]: string | number | boolean
}

export interface MigrationTelemetryOptions {
  /** Server URL — the same one the publisher CLI talks to. */
  serverUrl: string
  /** Test injection point. Defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Override the per-run session id. Defaults to a fresh UUID. */
  sessionId?: string
  /** Sink for soft failures. Defaults to stderr.write. */
  onWarn?: (msg: string) => void
}

export interface MigrationTelemetryEmitter {
  /** Emit a single telemetry event. Resolves on success;
   * resolves silently on transport failure (warning surfaced via
   * `onWarn` — never aborts the caller). */
  emit(event: TelemetryEventPayload): Promise<void>
  /** Session id stamped on every emit from this emitter. */
  readonly sessionId: string
}

/**
 * Build a one-shot telemetry emitter for the migration run.
 * Each `emit()` POSTs a single-event batch to
 * `<serverUrl>/api/ingest` with the shared session id and an
 * Origin header derived from `serverUrl`.
 */
export function makeMigrationTelemetryEmitter(
  options: MigrationTelemetryOptions,
): MigrationTelemetryEmitter {
  const fetchImpl = options.fetchImpl ?? fetch
  const sessionId = options.sessionId ?? randomUUID()
  const onWarn = options.onWarn ?? ((msg: string) => process.stderr.write(`${msg}\n`))
  const baseUrl = options.serverUrl.replace(/\/$/, '')
  const url = `${baseUrl}/api/ingest`
  // The endpoint's `isAllowedOrigin` rejects empty origins
  // outright. Derive Origin from the configured serverUrl so the
  // request matches the endpoint's own origin and the same-origin
  // allow-path fires. Malformed URLs leave Origin unset; the
  // endpoint will reject and the failure surfaces via onWarn.
  let originHeader = ''
  try {
    originHeader = new URL(baseUrl).origin
  } catch {
    // Caller's serverUrl is malformed; let the emit attempt 400
    // with a useful onWarn line rather than refusing here.
  }

  return {
    sessionId,
    async emit(event: TelemetryEventPayload): Promise<void> {
      const body = JSON.stringify({ session_id: sessionId, events: [event] })
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (originHeader) headers['Origin'] = originHeader

      let res: Response
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers,
          body,
        })
      } catch (e) {
        const label = describeEvent(event)
        onWarn(
          `migration-telemetry: emit unreachable for ${label}: ${e instanceof Error ? e.message : String(e)}`,
        )
        return
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        const label = describeEvent(event)
        onWarn(
          `migration-telemetry: emit returned ${res.status} for ${label}: ${text.slice(0, 100)}`,
        )
      }
    },
  }
}

/** Compact label for log lines — prefers dataset_id when present. */
function describeEvent(event: TelemetryEventPayload): string {
  const datasetId = event.dataset_id
  if (typeof datasetId === 'string' && datasetId.length > 0) return datasetId
  return event.event_type
}
