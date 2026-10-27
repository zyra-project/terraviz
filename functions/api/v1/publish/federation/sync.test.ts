// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Wire-level tests for POST /api/v1/publish/federation/sync.
 *
 * Coverage: the gate, field errors, an unknown or paused peer, a
 * successful pull against a signed feed (mirror rows and audit row),
 * and a failed pull that still answers 200 with its reason.
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
function serveFeed(datasets: unknown[]) {
  const fn = vi.fn(async (req: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(req))
    expect(url.origin).toBe(BASE)
    expect(init?.redirect).toBe('manual')
    const body = {
      schema_version: 1,
      node_id: PEER_ID,
      generated_at: new Date().toISOString(),
      cursor: encodeFeedCursor({ updatedAt: '2026-01-02T00:00:00.000Z', id: 'b' }),
      has_more: false,
      datasets,
      tombstones: [],
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

const auditRows = () =>
  sqlite
    .prepare("SELECT actor_id, subject_id, metadata_json FROM audit_events WHERE action = 'federation_peer.sync'")
    .all() as Array<{ actor_id: string; subject_id: string; metadata_json: string }>

describe('POST /api/v1/publish/federation/sync', () => {
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
      reconciled: 0,
      reconcile_pending: true,
    })
  })

  it('answers 409 while another pull holds the lease', async () => {
    const fn = serveFeed([])
    await d1FederationMirrorStore(asD1(sqlite)).acquireLease(PEER_ID, 'other', Date.now(), Date.now() + 600_000)
    const res = await onRequestPost(ctx({ body: { peer_id: PEER_ID } }))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'sync_in_progress' })
    expect(fn).not.toHaveBeenCalled()
  })

  it('answers 200 with the reason when the peer fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 503 })),
    )
    const res = await onRequestPost(ctx({ body: { peer_id: PEER_ID, full: true } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ result: { ok: false, error: 'http-status', status: 503 } })
    expect(JSON.parse(auditRows()[0].metadata_json)).toMatchObject({ ok: false, error: 'http-status' })
    const peer = await d1FederationPeerStore(asD1(sqlite)).getPeer(PEER_ID)
    expect(peer?.lastSyncError).toMatch(/^http-status/)
  })
})
