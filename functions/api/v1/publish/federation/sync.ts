// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * POST /api/v1/publish/federation/sync — pull one peer's feed now.
 *
 * Metadata Phase 5, step 5b. Body
 * `{ peer_id, full?, page_size?, accept_sweep? }`. Reads one page of
 * at most `page_size` entries (1-25, default 25) and returns
 * snake_case fields, including `held`: how many rows the peer listed as
 * ones it could not serve. There is no scheduler yet, so this is how a
 * mirror is refreshed; a full sync that runs out of pages resumes on
 * the next call. Admin-only, and a 404 unless `FEDERATION_ENABLED` is
 * `'true'`, by the same gate as `peers.ts`.
 *
 * **Two envelopes.** A `result` means a pull ran and may have applied a
 * page. A top-level `error` means none ran, except `sync_failed`, which
 * a store failure can raise after a page was applied.
 * - 400 `{ errors }` for field errors; 404 `peer_not_found`.
 * - 409 `peer_not_active`, for a paused or blocked peer: stop.
 * - 409 `sync_in_progress`: another pull holds the lease. Retry once it
 *   expires, at most five minutes.
 * - 500 `sync_failed`: this node's store failed, after an audit row
 *   recording `store-error`. A page may already have been applied, but
 *   not a sweep this node saw complete, since one that ran is reported
 *   even if recording the pull then fails. (A sweep whose commit was
 *   never acknowledged can have run unseen.) 500 `audit_failed`: the audit row an
 *   `accept_sweep` needs could not be written, so nothing ran.
 * - 200 with `result.ok: true`.
 * - 503 with `result.error`: the pull failed. Most codes are the peer's
 *   (`http_status` with `upstream_status`, `bad_signature`, …);
 *   `lease_lost` is this node's. The peer's `last_sync_error` stores the
 *   same failure in kebab-case, with any status appended (`http-status:503`).
 * - 409 with `result.error: 'sweep_refused'`, below. Stop and have a
 *   person look; never retry it on a loop.
 *
 * **A refused sweep.** A sweep that would drop all of the mirror, or
 * most of it, deletes nothing and answers 409 with
 * `result.sweep_refused: { sweep_id, kept, dropped }`. The page the pull
 * read is still applied. The guard judges both the counts the full sync
 * finished with and those when the sweep is due. The refusal is latched:
 * the sweep stays pending and runs only once accepted, or once it would
 * delete nothing. So every complete pull answers 409 again until a full
 * sync replaces it. A full sync that never completes keeps the refused
 * sweep in place with no way to accept it, and cannot be abandoned.
 *
 * To accept it, after checking the peer, send `sweep_refused` back as
 * `accept_sweep`. The sweep runs if it is still that `sweep_id` and would
 * drop at most `dropped` rows; `kept` is accepted and ignored.
 * `result.accept_sweep_result` says what happened. `stale` comes first:
 * the accept named a sweep that is not the one pending, or one a full
 * sync is replacing. It can come with a 200: when that sweep is gone,
 * or while a full sync is under way, which the call then carries on by
 * a page.
 * For the pending sweep: `ran` (`sweep_accepted` says what it dropped),
 * `not_needed` (the sweep ran without it), `stale` (it would drop more
 * than accepted; the 409 carries the current counts), or `not_reached`
 * (this call did not get to it: the page had more after it, the sweep is
 * not yet due, or the pull failed first, so send it again on a call
 * that completes). An audit
 * row naming who accepted which sweep is written before a pull that
 * could run it, and the pull does not run if it cannot be; the outcome
 * row carries its id as `accept_audit_id`.
 * `accept_sweep` cannot be combined with `full`, which replaces the
 * sweep it would accept.
 */

import type { CatalogEnv } from '../../_lib/env'
import type { PublisherData } from '../_middleware'
import { writeAuditEvent } from '../../_lib/audit-store'
import { newUlid } from '../../_lib/ulid'
import { d1FederationMirrorStore, d1FederationPeerStore } from '../../_lib/federation-mirror-d1'
import {
  federationAdminGate,
  federationError as jsonError,
  federationJson as json,
} from '../../_lib/federation-admin'
import {
  isFederationId,
  pullPeer,
  type SweepAcceptance,
  type SweepReport,
} from '../../_lib/federation-subscriber'

export const onRequestPost: PagesFunction<CatalogEnv> = async context => {
  const publisher = (context.data as unknown as PublisherData).publisher
  const gate = federationAdminGate(context.env, publisher)
  if (gate) return gate
  const db = context.env.CATALOG_DB!

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return jsonError(400, 'invalid_json', 'Request body must be JSON.')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return jsonError(400, 'invalid_body', 'Request body must be a JSON object.')
  }
  const input = body as Record<string, unknown>
  const errors: Array<{ field: string; code: string; message: string }> = []
  if (typeof input.peer_id !== 'string' || !isFederationId(input.peer_id)) {
    errors.push({ field: 'peer_id', code: 'invalid', message: 'Must be a peer\'s node id.' })
  }
  if (input.full !== undefined && typeof input.full !== 'boolean') {
    errors.push({ field: 'full', code: 'invalid', message: 'Must be true or false.' })
  }
  if (input.page_size !== undefined && (!Number.isInteger(input.page_size) || Number(input.page_size) < 1 || Number(input.page_size) > 25)) {
    errors.push({ field: 'page_size', code: 'invalid', message: 'Must be an integer from 1 to 25.' })
  }
  const acceptSweep = input.accept_sweep === undefined ? undefined : parseAcceptSweep(input.accept_sweep)
  if (acceptSweep === null) {
    errors.push({
      field: 'accept_sweep',
      code: 'invalid',
      message: 'Must be the sweep_refused object a refusal returned: { sweep_id, kept, dropped }.',
    })
  } else if (acceptSweep && input.full === true) {
    errors.push({
      field: 'accept_sweep',
      code: 'conflicts_with_full',
      message: 'Cannot be combined with full: a full sync replaces the sweep it would accept.',
    })
  }
  if (errors.length > 0) return json(400, { errors })

  const peerId = input.peer_id as string
  const peer = await d1FederationPeerStore(db).getPeer(peerId)
  if (!peer) return jsonError(404, 'peer_not_found', 'No peer with that node id.')
  if (peer.status !== 'active') {
    return jsonError(409, 'peer_not_active', `This peer is ${peer.status}; it is not pulled.`)
  }

  const audit = (metadata: Record<string, unknown>) =>
    writeAuditEvent(db, {
      actor_kind: 'publisher',
      actor_id: publisher.id,
      action: 'federation_peer.sync',
      subject_kind: 'peer',
      subject_id: peerId,
      metadata_json: JSON.stringify(metadata),
    })

  // An accepted sweep can delete most of a mirror, so who accepted it is
  // recorded before it can run, and it does not run unrecorded. Only an
  // accept that names the pending sweep can run one (a full sync never
  // finishes with an old run's id), so only that one needs the row.
  let acceptAuditId: string | null = null
  if (acceptSweep && peer.sweepRun === acceptSweep.sweepRun && peer.fullSyncRun === null) {
    acceptAuditId = await writeAuditEvent(db, {
      actor_kind: 'publisher',
      actor_id: publisher.id,
      action: 'federation_peer.sweep_accept',
      subject_kind: 'peer',
      subject_id: peerId,
      metadata_json: JSON.stringify(acceptJson(acceptSweep)),
    })
    if (acceptAuditId === null) {
      return jsonError(500, 'audit_failed', 'The acceptance could not be recorded, so the sweep was not run.')
    }
  }
  const acceptMeta = acceptSweep
    ? { accept_sweep: acceptJson(acceptSweep), ...(acceptAuditId ? { accept_audit_id: acceptAuditId } : {}) }
    : {}

  let result
  try {
    result = await pullPeer(
      peer,
      {
        fetch: (input, init) => fetch(input, init),
        store: d1FederationMirrorStore(db),
        now: () => Date.now(),
        newRunId: () => newUlid(),
      },
      {
        full: input.full === true,
        maxPages: 1,
        pageLimit: (input.page_size as number | undefined) ?? 25,
        // An accept with no intent row cannot run a sweep (see above), so
        // it is not handed to the pull at all: that it never runs
        // unrecorded rests on this line, not on which ids are shown.
        ...(acceptSweep && acceptAuditId ? { acceptSweep } : {}),
      },
    )
  } catch (err) {
    console.error('[federation/sync] store failure', peerId, err)
    await audit({ ok: false, error: 'store-error', ...acceptMeta }).catch(() => {})
    return jsonError(500, 'sync_failed', 'The pull failed on this node; see the logs.')
  }
  if (result.error === 'sync-in-progress' || result.error === 'peer-not-active') {
    // Nothing ran. An accept's intent row still gets its outcome.
    if (acceptAuditId) await audit({ ok: false, error: result.error, ...acceptMeta })
    return result.error === 'sync-in-progress'
      ? jsonError(409, 'sync_in_progress', 'Another pull of this peer is running.')
      : jsonError(409, 'peer_not_active', 'This peer is no longer active; it is not pulled.')
  }

  const acceptOutcome = acceptSweep && !acceptAuditId ? 'stale' : result.acceptOutcome
  await audit({
    ok: result.ok,
    ...(result.error ? { error: result.error } : {}),
    full: result.full,
    complete: result.complete,
    upserted: result.upserted,
    tombstoned: result.tombstoned,
    held: result.held,
    reconciled: result.reconciled,
    reconcile_pending: result.reconcilePending,
    ...acceptMeta,
    ...(acceptOutcome ? { accept_sweep_result: acceptOutcome } : {}),
    ...(result.sweepRefused ? { sweep_refused: sweepJson(result.sweepRefused) } : {}),
    ...(result.sweepAccepted ? { sweep_accepted: sweepJson(result.sweepAccepted) } : {}),
  })
  const status = result.ok ? 200 : result.error === 'sweep-refused' ? 409 : 503
  return json(status, { result: {
    ok: result.ok,
    full: result.full,
    complete: result.complete,
    pages: result.pages,
    upserted: result.upserted,
    tombstoned: result.tombstoned,
    held: result.held,
    reconciled: result.reconciled,
    reconcile_pending: result.reconcilePending,
    ...(result.error ? { error: result.error.replaceAll('-', '_') } : {}),
    ...(result.status !== undefined ? { upstream_status: result.status } : {}),
    ...(result.sweepRefused ? { sweep_refused: sweepJson(result.sweepRefused) } : {}),
    ...(result.sweepAccepted ? { sweep_accepted: sweepJson(result.sweepAccepted) } : {}),
    ...(acceptOutcome ? { accept_sweep_result: acceptOutcome.replaceAll('-', '_') } : {}),
  } })
}

const sweepJson = (report: SweepReport) => ({
  sweep_id: report.sweepRun,
  kept: report.kept,
  dropped: report.dropped,
})

const acceptJson = (accept: SweepAcceptance) => ({ sweep_id: accept.sweepRun, dropped: accept.dropped })

/**
 * `sweep_refused` sent back: `{ sweep_id, dropped }`, and the `kept` it
 * also carries, or `null`. The two shapes change together: a field
 * added to `sweep_refused` must be allowed here, or sending it back
 * fails (the route's round-trip test pins this).
 */
function parseAcceptSweep(value: unknown): SweepAcceptance | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => key !== 'sweep_id' && key !== 'kept' && key !== 'dropped')) return null
  const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0
  if (typeof record.sweep_id !== 'string' || !isFederationId(record.sweep_id)) return null
  if (!count(record.dropped) || (record.kept !== undefined && !count(record.kept))) return null
  return { sweepRun: record.sweep_id, dropped: record.dropped }
}
