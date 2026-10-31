// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Wire-level tests for /api/v1/publish/federation/peers.
 *
 * Coverage: the gate (404 with federation off, before the role check;
 * 403 for a non-admin), field errors, a node adding itself, the
 * discovery check (unreachable, each mismatch, feed off), a 201 add
 * with its audit row, a duplicate that never replaces the pinned key,
 * and the list.
 */

import { generateKeyPairSync } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestGet, onRequestPost } from './peers'
import { asD1, seedFixtures } from '../../_lib/test-helpers'
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

function wireKey(): string {
  const { publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer
  return `ed25519:${spki.subarray(spki.length - 32).toString('base64')}`
}
const PEER_KEY = wireKey()
const OTHER_KEY = wireKey()

type Env = Record<string, unknown>
let env: Env
let sqlite: ReturnType<typeof seedFixtures>

beforeEach(() => {
  sqlite = seedFixtures({ count: 0 })
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ADMIN.id, ADMIN.email, ADMIN.display_name, ADMIN.role, ADMIN.is_admin, ADMIN.status, ADMIN.created_at)
  env = { CATALOG_DB: asD1(sqlite), FEDERATION_ENABLED: 'true' }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function ctx(opts: { method: 'GET' | 'POST'; publisher?: PublisherRow; body?: unknown; rawBody?: string; env?: Env }) {
  const url = 'https://localhost/api/v1/publish/federation/peers'
  const init: RequestInit = { method: opts.method, headers: new Headers() }
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

const input = (over: Record<string, unknown> = {}) => ({
  base_url: BASE,
  node_id: PEER_ID,
  public_key: PEER_KEY,
  ...over,
})

const discovery = (over: Record<string, unknown> = {}) => ({
  node_id: PEER_ID,
  display_name: 'Peer node',
  base_url: BASE,
  public_key: PEER_KEY,
  federation: { feed: true },
  ...over,
})

/** Stub the global fetch with a peer serving `doc` at its well-known path. */
function servePeer(doc: unknown | Response) {
  const fn = vi.fn(async (req: RequestInfo | URL) => {
    expect(String(req)).toBe(`${BASE}/.well-known/terraviz.json`)
    if (doc instanceof Response) return doc
    return new Response(JSON.stringify(doc), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

async function peerRows() {
  return sqlite.prepare('SELECT id, base_url, display_name, public_key, status FROM federation_peers ORDER BY id').all()
}

describe('the federation admin gate', () => {
  it('is a 404 with federation off, even for an admin and before reading the body', async () => {
    const fn = servePeer(discovery())
    for (const off of [{}, { FEDERATION_ENABLED: 'false' }, { FEDERATION_ENABLED: '1' }]) {
      const e = { CATALOG_DB: env.CATALOG_DB, ...off }
      expect((await onRequestGet(ctx({ method: 'GET', env: e }))).status).toBe(404)
      expect((await onRequestPost(ctx({ method: 'POST', env: e, rawBody: '{' }))).status).toBe(404)
    }
    expect(fn).not.toHaveBeenCalled()
  })

  it('is a 403 for a publisher who is not an admin', async () => {
    const res = await onRequestPost(ctx({ method: 'POST', publisher: PUBLISHER, body: input() }))
    expect(res.status).toBe(403)
    expect((await onRequestGet(ctx({ method: 'GET', publisher: PUBLISHER }))).status).toBe(403)
  })

  it('answers no-store', async () => {
    const res = await onRequestGet(ctx({ method: 'GET' }))
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })
})

describe('POST /api/v1/publish/federation/peers', () => {
  it('adds a peer whose discovery document matches, pinning the key typed', async () => {
    servePeer(discovery())
    const res = await onRequestPost(ctx({ method: 'POST', body: input() }))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({
      peer: { id: PEER_ID, base_url: BASE, display_name: 'Peer node', status: 'active' },
    })
    expect(await peerRows()).toEqual([
      { id: PEER_ID, base_url: BASE, display_name: 'Peer node', public_key: PEER_KEY, status: 'active' },
    ])
    const audit = sqlite
      .prepare("SELECT actor_id, action, subject_kind, subject_id FROM audit_events WHERE action = 'federation_peer.add'")
      .all()
    expect(audit).toEqual([{ actor_id: ADMIN.id, action: 'federation_peer.add', subject_kind: 'peer', subject_id: PEER_ID }])
  })

  it('prefers the display name the operator gave and accepts a trailing slash', async () => {
    servePeer(discovery())
    const res = await onRequestPost(ctx({ method: 'POST', body: input({ base_url: `${BASE}/`, display_name: '  Ours  ' }) }))
    expect(res.status).toBe(201)
    expect((await peerRows())[0]).toMatchObject({ base_url: BASE, display_name: 'Ours' })
  })

  it('stores the canonical key when pasted without padding and with a trailing newline', async () => {
    servePeer(discovery())
    const res = await onRequestPost(ctx({ method: 'POST', body: input({ public_key: PEER_KEY.replace(/=+$/, '') + '\n' }) }))
    expect(res.status).toBe(201)
    expect((await peerRows())[0]).toMatchObject({ public_key: PEER_KEY })
  })

  it('returns field errors without fetching anything', async () => {
    const fn = servePeer(discovery())
    const res = await onRequestPost(
      ctx({
        method: 'POST',
        body: { base_url: 'http://peer.example.org', node_id: 'a/b', public_key: 'ed25519:short', display_name: '' },
      }),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { errors: Array<{ field: string }> }
    expect(body.errors.map(e => e.field).sort()).toEqual(['base_url', 'display_name', 'node_id', 'public_key'])
    expect(fn).not.toHaveBeenCalled()
  })

  it('refuses a base URL with a path or an IP literal', async () => {
    for (const base_url of [`${BASE}/catalog`, 'https://192.0.2.1', 'https://user@peer.example.org']) {
      const res = await onRequestPost(ctx({ method: 'POST', body: input({ base_url }) }))
      expect(res.status).toBe(400)
    }
  })

  it('refuses a body that is not a JSON object', async () => {
    expect((await onRequestPost(ctx({ method: 'POST', rawBody: 'nope' }))).status).toBe(400)
    expect((await onRequestPost(ctx({ method: 'POST', body: [input()] }))).status).toBe(400)
  })

  it('refuses this node as its own peer', async () => {
    const fn = servePeer(discovery())
    const res = await onRequestPost(ctx({ method: 'POST', body: input({ node_id: 'NODE000' }) }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ errors: [{ field: 'node_id', code: 'self' }] })
    expect(fn).not.toHaveBeenCalled()
  })

  it('is a 503 when the discovery document cannot be read', async () => {
    servePeer(new Response(null, { status: 302, headers: { location: 'https://evil.example.org/' } }))
    const res = await onRequestPost(ctx({ method: 'POST', body: input() }))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'peer_unreachable', reason: 'redirect', status: 302 })
    expect(await peerRows()).toEqual([])
    const audit = sqlite.prepare("SELECT actor_id, subject_id, metadata_json FROM audit_events WHERE action = 'federation_peer.add'").get() as { actor_id: string; subject_id: string; metadata_json: string }
    expect(audit).toMatchObject({ actor_id: ADMIN.id, subject_id: PEER_ID })
    expect(JSON.parse(audit.metadata_json)).toEqual({ outcome: 'refused', reason: 'peer_unreachable' })
  })

  it('is a 422 naming each field the discovery document disagrees on', async () => {
    servePeer(discovery({ node_id: 'SOMEONEELSE', public_key: OTHER_KEY, base_url: 'https://other.example.org' }))
    const res = await onRequestPost(ctx({ method: 'POST', body: input() }))
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'peer_mismatch', fields: ['node_id', 'public_key', 'base_url'] })
    expect(await peerRows()).toEqual([])
  })

  it('is a 422 when the peer serves no feed', async () => {
    servePeer(discovery({ federation: { feed: false } }))
    const res = await onRequestPost(ctx({ method: 'POST', body: input() }))
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'peer_feed_off' })
  })

  it('never replaces a pinned key', async () => {
    servePeer(discovery())
    expect((await onRequestPost(ctx({ method: 'POST', body: input() }))).status).toBe(201)
    servePeer(discovery({ public_key: OTHER_KEY }))
    const res = await onRequestPost(ctx({ method: 'POST', body: input({ public_key: OTHER_KEY }) }))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'peer_exists' })
    expect((await peerRows())[0]).toMatchObject({ public_key: PEER_KEY })
  })

  it('is a 409 for a second id at a base URL already registered', async () => {
    servePeer(discovery())
    expect((await onRequestPost(ctx({ method: 'POST', body: input() }))).status).toBe(201)
    servePeer(discovery({ node_id: 'SECONDPEER' }))
    const res = await onRequestPost(ctx({ method: 'POST', body: input({ node_id: 'SECONDPEER' }) }))
    expect(res.status).toBe(409)
  })
})

describe('GET /api/v1/publish/federation/peers', () => {
  it('lists peers with their sync state', async () => {
    servePeer(discovery())
    await onRequestPost(ctx({ method: 'POST', body: input() }))
    const res = await onRequestGet(ctx({ method: 'GET' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      peers: [
        {
          id: PEER_ID,
          base_url: BASE,
          display_name: 'Peer node',
          public_key: PEER_KEY,
          status: 'active',
          last_sync_at: null,
          last_sync_error: null,
          full_sync_in_progress: false,
          reconcile_pending: false,
          sweep_refused: false,
          sweep_flagged: false,
          sweep_after: null,
          sync_lease_expires: null,
          mirrored_count: 0,
        },
      ],
    })
  })

  it('marks a peer whose sweep is refused and waiting for an admin', async () => {
    servePeer(discovery())
    await onRequestPost(ctx({ method: 'POST', body: input() }))
    sqlite.prepare("UPDATE federation_peers SET sweep_run = 'RUN1', sweep_after = 5 WHERE id = ?").run(PEER_ID)
    const due = (await (await onRequestGet(ctx({ method: 'GET' }))).json()) as { peers: Array<Record<string, unknown>> }
    expect(due.peers[0]).toMatchObject({ reconcile_pending: true, sweep_refused: false, sweep_after: 5 })
    sqlite.prepare('UPDATE federation_peers SET sweep_after = NULL WHERE id = ?').run(PEER_ID)
    const refused = (await (await onRequestGet(ctx({ method: 'GET' }))).json()) as { peers: Array<Record<string, unknown>> }
    expect(refused.peers[0]).toMatchObject({ reconcile_pending: true, sweep_refused: true, sweep_after: null })
    // A full sync under way will replace it, so it is no longer waiting for an admin.
    sqlite.prepare("UPDATE federation_peers SET full_sync_run = 'RUN2' WHERE id = ?").run(PEER_ID)
    const replacing = (await (await onRequestGet(ctx({ method: 'GET' }))).json()) as { peers: Array<Record<string, unknown>> }
    expect(replacing.peers[0]).toMatchObject({ full_sync_in_progress: true, sweep_refused: false })
  })
})
