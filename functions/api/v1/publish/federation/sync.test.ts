// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Wire-level tests for POST /api/v1/publish/federation/sync.
 *
 * Coverage: the gate, field errors, an unknown or paused peer, a
 * successful pull against a signed feed (mirror rows and audit row),
 * held rows, a refused sweep and its acceptance, and a failed pull
 * that answers 503 with its reason.
 */

import { generateKeyPairSync } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestPost } from './sync'
import { asD1, seedFixtures } from '../../_lib/test-helpers'
import { d1FederationMirrorStore, d1FederationPeerStore } from '../../_lib/federation-mirror-d1'
import { encodeFeedCursor } from '../../_lib/federation-feed'
import {
  SIGNATURE_HEADER,
  importNodeSigningKey,
  signFederationBody,
} from '../../_lib/federation-signature'
import type { PublisherRow } from '../../_lib/publisher-store'

const ADMIN: PublisherRow = {
  id: 'PUB-ADMIN',
  email: 'admin@example.com',
  display_name: 'Admin',
  affiliation: null,
  org_id: null,
  role: 'admin',
  is_admin: 1,
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
}
const PUBLISHER: PublisherRow = { ...ADMIN, id: 'PUB-PUB', email: 'p@e', role: 'publisher', is_admin: 0 }

const PEER_ID = '01J00000000000000000000PEER'
const BASE = 'https://peer.example.org'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const PRIVATE_B64 = (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64')
const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer
const PUBLIC_WIRE = `ed25519:${spki.subarray(spki.length - 32).toString('base64')}`

type Env = Record<string, unknown>
let env: Env
let sqlite: ReturnType<typeof seedFixtures>

beforeEach(async () => {
  sqlite = seedFixtures({ count: 0 })
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ADMIN.id, ADMIN.email, ADMIN.display_name, ADMIN.role, ADMIN.is_admin, ADMIN.status, ADMIN.created_at)
  env = { CATALOG_DB: asD1(sqlite), FEDERATION_ENABLED: 'true' }
  await d1FederationPeerStore(asD1(sqlite)).addPeer(
    { id: PEER_ID, baseUrl: BASE, displayName: 'Peer', publicKey: PUBLIC_WIRE },
    '2026-01-01T00:00:00.000Z',
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function ctx(opts: { publisher?: PublisherRow; body?: unknown; rawBody?: string; env?: Env }) {
  const url = 'https://localhost/api/v1/publish/federation/sync'
  const init: RequestInit = { method: 'POST' }
  if (opts.rawBody !== undefined) init.body = opts.rawBody
  else if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
  return {
    request: new Request(url, init),
    env: opts.env ?? env,
    params: {},
    data: { publisher: opts.publisher ?? ADMIN },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: new URL(url).pathname,
  } as unknown as Parameters<typeof onRequestPost>[0]
}

/** Stub the global fetch with a peer serving one signed feed page. */
function serveFeed(datasets: unknown[], hasMore = false, extra: Record<string, unknown> = {}) {
  const fn = vi.fn(async (req: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(req))
    expect(url.origin).toBe(BASE)
    expect(init?.redirect).toBe('manual')
    const body = {
      schema_version: 1,
      node_id: PEER_ID,
      generated_at: new Date().toISOString(),
      cursor: encodeFeedCursor({ updatedAt: '2026-01-02T00:00:00.000Z', id: 'b' }),
      has_more: hasMore,
      datasets,
      tombstones: [],
      ...extra,
    }
    const signed = await signFederationBody(body, await importNodeSigningKey(PRIVATE_B64), {
      keyId: PEER_ID,
      created: Math.floor(Date.now() / 1000),
      target: url.pathname + url.search,
    })
    return new Response(signed.text, {
      status: 200,
      headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signed.header },
    })
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function seedMirrored(ids: string[], run: string) {
  for (const id of ids) {
    sqlite
      .prepare(
        `INSERT INTO federated_datasets (peer_id, remote_id, origin_node, payload_json, feed_signature, seen_run, fetched_at)
         VALUES (?, ?, ?, '{}', 'sig', ?, '2026-01-01T00:00:00.000Z')`,
      )
      .run(PEER_ID, id, PEER_ID, run)
  }
}

/** A finished full sync that delivered nothing (run RUN1), its settle
 *  window passed, over two rows from an earlier run. */
function pendingEmptySweep() {
  seedMirrored(['x', 'y'], 'RUN0')
  sqlite
    .prepare('UPDATE federation_peers SET last_sync_cursor = ?, sweep_run = ?, sweep_after = ? WHERE id = ?')
    .run(encodeFeedCursor({ updatedAt: '2026-01-01T00:00:00.000Z', id: 'a' }), 'RUN1', 0, PEER_ID)
}

const mirroredIds = () =>
  (sqlite.prepare('SELECT remote_id FROM federated_datasets ORDER BY remote_id').all() as Array<{ remote_id: string }>).map(r => r.remote_id)

const auditRows = () =>
  sqlite
    .prepare("SELECT actor_id, subject_id, metadata_json FROM audit_events WHERE action = 'federation_peer.sync'")
    .all() as Array<{ actor_id: string; subject_id: string; metadata_json: string }>

describe('POST /api/v1/publish/federation/sync', () => {
  it('uses fewer than 50 D1 statements including the route and audit for 25 rows', async () => {
    const prepare = vi.spyOn(sqlite, 'prepare')
    const fetchFn = serveFeed(Array.from({ length: 25 }, (_, index) => ({ id: `row-${index}`, originNode: PEER_ID })), true)
    const res = await onRequestPost(ctx({ body: { peer_id: PEER_ID } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ result: { ok: true, pages: 1, complete: false, upserted: 25 } })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(String(fetchFn.mock.calls[0][0])).toContain('limit=25')
    expect(prepare.mock.calls.length).toBeGreaterThan(25)
    expect(prepare.mock.calls.length).toBeLessThan(50)
    prepare.mockRestore()
  })

  it('rejects invalid page sizes and honors a smaller operator-selected page', async () => {
    const fetchFn = serveFeed([])
    for (const page_size of [0, 26, 1.5, '5']) {
      const res = await onRequestPost(ctx({ body: { peer_id: PEER_ID, page_size } }))
      expect(res.status).toBe(400)
    }
    expect(fetchFn).not.toHaveBeenCalled()
    expect((await onRequestPost(ctx({ body: { peer_id: PEER_ID, page_size: 5 } }))).status).toBe(200)
    expect(String(fetchFn.mock.calls[0][0])).toContain('limit=5')
  })

  it('reports an invalid cursor separately so the operator can restart a full sync', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"invalid_cursor"}', { status: 400, headers: { 'content-type': 'application/json' } })))
    const res = await onRequestPost(ctx({ body: { peer_id: PEER_ID } }))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ result: { error: 'invalid_cursor', upstream_status: 400 } })
  })

  it('is a 404 with federation off and a 403 for a non-admin', async () => {
    const fn = serveFeed([])
    expect((await onRequestPost(ctx({ env: { CATALOG_DB: env.CATALOG_DB }, body: { peer_id: PEER_ID } }))).status).toBe(404)
    expect((await onRequestPost(ctx({ publisher: PUBLISHER, body: { peer_id: PEER_ID } }))).status).toBe(403)
    expect(fn).not.toHaveBeenCalled()
  })

  it('returns field errors', async () => {
    expect((await onRequestPost(ctx({ rawBody: '{' }))).status).toBe(400)
    const res = await onRequestPost(ctx({ body: { peer_id: 'a/b', full: 'yes' } }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { errors: Array<{ field: string }> }
    expect(body.errors.map(e => e.field)).toEqual(['peer_id', 'full'])
  })

  it('is a 404 for an unknown peer and a 409 for a paused one', async () => {
    const fn = serveFeed([])
    expect((await onRequestPost(ctx({ body: { peer_id: 'NOBODY' } }))).status).toBe(404)
    sqlite.prepare("UPDATE federation_peers SET status = 'paused' WHERE id = ?").run(PEER_ID)
    const res = await onRequestPost(ctx({ body: { peer_id: PEER_ID } }))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'peer_not_active' })
    expect(fn).not.toHaveBeenCalled()
  })

  it('pulls a signed feed into the mirror and audits it', async () => {
    serveFeed([
      { id: 'a', title: 'A', originNode: PEER_ID },
      { id: 'b', title: 'B', originNode: PEER_ID },
    ])
    const res = await onRequestPost(ctx({ body: { peer_id: PEER_ID } }))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(await res.json()).toMatchObject({ result: { ok: true, full: true, complete: true, upserted: 2 } })
    const rows = sqlite.prepare('SELECT remote_id FROM federated_datasets ORDER BY remote_id').all()
    expect(rows).toEqual([{ remote_id: 'a' }, { remote_id: 'b' }])
    const audit = auditRows()
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ actor_id: ADMIN.id, subject_id: PEER_ID })
    expect(JSON.parse(audit[0].metadata_json)).toEqual({
      ok: true,
      full: true,
      complete: true,
      upserted: 2,
      tombstoned: 0,
      held: 0,
      reconciled: 0,
      reconcile_pending: true,
    })
  })

  it('reports held rows and keeps their copies', async () => {
    seedMirrored(['x'], 'RUN0')
    serveFeed([{ id: 'a', originNode: PEER_ID }], false, { held: ['x'] })
    const res = await onRequestPost(ctx({ body: { peer_id: PEER_ID } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ result: { ok: true, upserted: 1, held: 1 } })
    expect(sqlite.prepare("SELECT payload_json FROM federated_datasets WHERE remote_id = 'x'").get()).toEqual({ payload_json: '{}' })
    expect(JSON.parse(auditRows()[0].metadata_json)).toMatchObject({ held: 1 })
  })

  it('answers 409 while another pull holds the lease', async () => {
    const fn = serveFeed([])
    await d1FederationMirrorStore(asD1(sqlite)).acquireLease(PEER_ID, 'other', Date.now(), Date.now() + 600_000)
    const res = await onRequestPost(ctx({ body: { peer_id: PEER_ID } }))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'sync_in_progress' })
    expect(fn).not.toHaveBeenCalled()
  })

  it('answers 409 sweep_refused on every pull, keeping the mirror, while a sweep would empty it', async () => {
    pendingEmptySweep()
    serveFeed([])
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await onRequestPost(ctx({ body: { peer_id: PEER_ID } }))
      expect(res.status).toBe(409)
      const body = (await res.json()) as Record<string, unknown>
      // A pull ran, so the error is in the result, not at the top level.
      expect(body).not.toHaveProperty('error')
      expect(body).toMatchObject({
        result: {
          ok: false,
          error: 'sweep_refused',
          reconciled: 0,
          reconcile_pending: true,
          sweep_refused: { sweep_id: 'RUN1', kept: 0, dropped: 2 },
        },
      })
    }
    expect(mirroredIds()).toEqual(['x', 'y'])
    expect(sqlite.prepare('SELECT sweep_run, sweep_after FROM federation_peers WHERE id = ?').get(PEER_ID)).toEqual({ sweep_run: 'RUN1', sweep_after: null })
    expect(JSON.parse(auditRows()[1].metadata_json)).toMatchObject({
      ok: false,
      error: 'sweep-refused',
      sweep_refused: { sweep_id: 'RUN1', kept: 0, dropped: 2 },
    })
  })

  it('runs a refused sweep when its sweep_refused is sent back as accept_sweep, and audits who did first', async () => {
    pendingEmptySweep()
    serveFeed([])
    const refused = (await (await onRequestPost(ctx({ body: { peer_id: PEER_ID } }))).json()) as {
      result: { sweep_refused: Record<string, unknown> }
    }
    // Sent back exactly as it arrived; if sweep_refused gains a field this
    // route does not accept, this is the test that says so.
    const res = await onRequestPost(ctx({ body: { peer_id: PEER_ID, accept_sweep: refused.result.sweep_refused } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      result: {
        ok: true,
        reconciled: 2,
        reconcile_pending: false,
        accept_sweep_result: 'ran',
        sweep_accepted: { sweep_id: 'RUN1', kept: 0, dropped: 2 },
      },
    })
    expect(mirroredIds()).toEqual([])
    const intent = sqlite
      .prepare("SELECT actor_id, subject_id, metadata_json FROM audit_events WHERE action = 'federation_peer.sweep_accept'")
      .all() as Array<{ actor_id: string; subject_id: string; metadata_json: string }>
    expect(intent).toHaveLength(1)
    expect(intent[0]).toMatchObject({ actor_id: ADMIN.id, subject_id: PEER_ID })
    expect(JSON.parse(intent[0].metadata_json)).toEqual({ sweep_id: 'RUN1', dropped: 2 })
    expect(JSON.parse(auditRows()[1].metadata_json)).toMatchObject({
      ok: true,
      reconciled: 2,
      accept_sweep: { sweep_id: 'RUN1', dropped: 2 },
      accept_sweep_result: 'ran',
      sweep_accepted: { sweep_id: 'RUN1', kept: 0, dropped: 2 },
    })
  })

  it('refuses an accept for another sweep or more rows, and says one went unused', async () => {
    pendingEmptySweep()
    serveFeed([])
    for (const accept_sweep of [{ sweep_id: 'RUN0', dropped: 2 }, { sweep_id: 'RUN1', dropped: 1 }]) {
      const res = await onRequestPost(ctx({ body: { peer_id: PEER_ID, accept_sweep } }))
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ result: { error: 'sweep_refused', accept_sweep_result: 'stale', sweep_refused: { sweep_id: 'RUN1', dropped: 2 } } })
    }
    expect(mirroredIds()).toEqual(['x', 'y'])

    // A page with more after it never reaches the sweep: 200, but unused.
    serveFeed([], true)
    const partial = await onRequestPost(ctx({ body: { peer_id: PEER_ID, accept_sweep: { sweep_id: 'RUN1', dropped: 2 } } }))
    expect(partial.status).toBe(200)
    expect(await partial.json()).toMatchObject({ result: { ok: true, complete: false, accept_sweep_result: 'not_reached' } })
    expect(mirroredIds()).toEqual(['x', 'y'])
  })

  it('does not run an accept it cannot record', async () => {
    pendingEmptySweep()
    const fn = serveFeed([])
    sqlite.exec('DROP TABLE audit_events')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await onRequestPost(ctx({ body: { peer_id: PEER_ID, accept_sweep: { sweep_id: 'RUN1', dropped: 2 } } }))
    errors.mockRestore()
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: 'audit_failed' })
    expect(fn).not.toHaveBeenCalled()
    expect(mirroredIds()).toEqual(['x', 'y'])
  })

  it('stays under 50 D1 statements on a full page of held rows that runs an accepted sweep', async () => {
    pendingEmptySweep()
    const held = Array.from({ length: 25 }, (_, index) => `held-${index}`)
    serveFeed([], false, { held })
    const prepare = vi.spyOn(sqlite, 'prepare')
    const res = await onRequestPost(ctx({ body: { peer_id: PEER_ID, accept_sweep: { sweep_id: 'RUN1', dropped: 2 } } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ result: { held: 25, reconciled: 2, accept_sweep_result: 'ran' } })
    expect(prepare.mock.calls.length).toBeLessThan(50)
    prepare.mockRestore()
  })

  it('refuses an accept_sweep that is not a sweep_refused, or comes with full', async () => {
    const fn = serveFeed([])
    for (const accept_sweep of [
      null,
      '0,2',
      [0, 2],
      { kept: 0, dropped: 2 },
      { sweep_id: 'RUN1' },
      { sweep_id: 'a/b', dropped: 2 },
      { sweep_id: 7, dropped: 2 },
      { sweep_id: 'RUN1', dropped: -1 },
      { sweep_id: 'RUN1', dropped: 1.5 },
      { sweep_id: 'RUN1', dropped: '2' },
      { sweep_id: 'RUN1', kept: 'x', dropped: 2 },
      { sweep_id: 'RUN1', dropped: 2, extra: true },
    ]) {
      const res = await onRequestPost(ctx({ body: { peer_id: PEER_ID, accept_sweep } }))
      expect(res.status).toBe(400)
      expect(((await res.json()) as { errors: Array<{ field: string; code: string }> }).errors).toEqual([
        expect.objectContaining({ field: 'accept_sweep', code: 'invalid' }),
      ])
    }
    const res = await onRequestPost(ctx({ body: { peer_id: PEER_ID, full: true, accept_sweep: { sweep_id: 'RUN1', dropped: 2 } } }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { errors: Array<{ field: string; code: string }> }).errors).toEqual([
      expect.objectContaining({ field: 'accept_sweep', code: 'conflicts_with_full' }),
    ])
    expect(fn).not.toHaveBeenCalled()
  })

  it('answers 503 with the reason when the peer fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 503 })),
    )
    const res = await onRequestPost(ctx({ body: { peer_id: PEER_ID, full: true } }))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ result: { ok: false, error: 'http_status', upstream_status: 503 } })
    expect(JSON.parse(auditRows()[0].metadata_json)).toMatchObject({ ok: false, error: 'http-status' })
    const peer = await d1FederationPeerStore(asD1(sqlite)).getPeer(PEER_ID)
    expect(peer?.lastSyncError).toMatch(/^http-status/)
  })
})
