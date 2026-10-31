// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * POST /api/v1/publish/federation/sync — pull one peer's feed now.
 *
 * Metadata Phase 5, step 5b. Body
 * `{ peer_id, full?, page_size?, accept_sweep? }`. Reads one page of
 * at most 25 entries and returns snake_case fields, including `held`:
 * how many rows the peer listed as ones it could not serve.
 * There is no scheduler yet, so this is how a mirror is refreshed;
 * a full sync that runs out of pages resumes on the next call.
 *
 * Admin-only, and a 404 unless `FEDERATION_ENABLED` is `'true'`, by
 * the same gate as `peers.ts`. 404 `peer_not_found` for an unknown
 * peer, 409 `peer_not_active` for one that is paused or blocked, 409
 * `sync_in_progress` while another pull of the same peer holds its
 * lease. A pull that fails because of the peer answers 503 and
 * the result names why (the
 * same code is stored as the peer's `last_sync_error`). A failure of
 * this node's own store answers 500 `sync_failed`, after an audit row
 * recording `store-error`.
 *
 * **A refused sweep.** A sweep that would drop most of the mirror, or
 * all of it, deletes nothing and answers 409 with
 * `{ result: { ok: false, error: 'sweep_refused', sweep_refused: { kept, dropped }, … } }`.
 * The pages this pull read are still applied. The sweep stays pending,
 * so every complete pull answers the same way until a full sync
 * replaces it, or until an admin who has checked the peer accepts it:
 * `accept_sweep: { kept, dropped }` runs the sweep if its counts are
 * still exactly those, and the result then carries `sweep_accepted`.
 * Counts that have moved are refused again with the new ones. The
 * audit row records the counts accepted and who accepted them.
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
import { isFederationId, pullPeer, type SweepCounts } from '../../_lib/federation-subscriber'

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
  const acceptSweep = input.accept_sweep === undefined ? undefined : parseSweepCounts(input.accept_sweep)
  if (acceptSweep === null) {
    errors.push({
      field: 'accept_sweep',
      code: 'invalid',
      message: 'Must be { kept, dropped }, the whole numbers a sweep_refused result reported.',
    })
  } else if (acceptSweep && input.full === true) {
    errors.push({
      field: 'accept_sweep',
      code: 'invalid',
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
        ...(acceptSweep ? { acceptSweep } : {}),
      },
    )
  } catch (err) {
    console.error('[federation/sync] store failure', peerId, err)
    await audit({ ok: false, error: 'store-error', ...(acceptSweep ? { accept_sweep: acceptSweep } : {}) }).catch(() => {})
    return jsonError(500, 'sync_failed', 'The pull failed on this node; see the logs.')
  }
  if (result.error === 'sync-in-progress') {
    return jsonError(409, 'sync_in_progress', 'Another pull of this peer is running.')
  }
  if (result.error === 'peer-not-active') {
    return jsonError(409, 'peer_not_active', 'This peer is no longer active; it is not pulled.')
  }

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
    ...(acceptSweep ? { accept_sweep: acceptSweep } : {}),
    ...(result.sweepRefused ? { sweep_refused: result.sweepRefused } : {}),
    ...(result.sweepAccepted ? { sweep_accepted: result.sweepAccepted } : {}),
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
    ...(result.sweepRefused ? { sweep_refused: result.sweepRefused } : {}),
    ...(result.sweepAccepted ? { sweep_accepted: result.sweepAccepted } : {}),
  } })
}

/** `{ kept, dropped }` as two non-negative whole numbers and nothing
 *  else, or `null`. */
function parseSweepCounts(value: unknown): SweepCounts | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 2 || !keys.includes('kept') || !keys.includes('dropped')) return null
  const { kept, dropped } = value as Record<string, unknown>
  const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0
  return count(kept) && count(dropped) ? { kept, dropped } : null
}
