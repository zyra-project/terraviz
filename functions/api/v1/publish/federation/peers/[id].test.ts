// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { beforeEach, describe, expect, it } from 'vitest'
import { onRequestDelete } from './[id]'
import { asD1, seedFixtures } from '../../../_lib/test-helpers'
import { d1FederationPeerStore } from '../../../_lib/federation-mirror-d1'
import type { PublisherRow } from '../../../_lib/publisher-store'

const ADMIN: PublisherRow = {
  id: 'PUB-ADMIN', email: 'admin@example.com', display_name: 'Admin', affiliation: null, org_id: null,
  role: 'admin', is_admin: 1, status: 'active', created_at: '2026-01-01T00:00:00.000Z',
}
const PUBLISHER: PublisherRow = { ...ADMIN, id: 'PUB-PUB', email: 'p@e', role: 'publisher', is_admin: 0 }
const PEER_ID = '01J00000000000000000000PEER'

let sqlite: ReturnType<typeof seedFixtures>
let env: Record<string, unknown>

beforeEach(async () => {
  sqlite = seedFixtures({ count: 0 })
  sqlite
    .prepare(`INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(ADMIN.id, ADMIN.email, ADMIN.display_name, ADMIN.role, ADMIN.is_admin, ADMIN.status, ADMIN.created_at)
  env = { CATALOG_DB: asD1(sqlite), FEDERATION_ENABLED: 'true' }
  await d1FederationPeerStore(asD1(sqlite)).addPeer(
    { id: PEER_ID, baseUrl: 'https://peer.example.org', displayName: 'Peer', publicKey: 'ed25519:x' },
    '2026-01-01T00:00:00.000Z',
  )
})

function ctx(id: string, opts: { publisher?: PublisherRow; env?: Record<string, unknown> } = {}) {
  const url = `https://localhost/api/v1/publish/federation/peers/${id}`
  return {
    request: new Request(url, { method: 'DELETE' }),
    env: opts.env ?? env,
    params: { id },
    data: { publisher: opts.publisher ?? ADMIN },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: new URL(url).pathname,
  } as unknown as Parameters<typeof onRequestDelete>[0]
}

describe('DELETE /api/v1/publish/federation/peers/:id', () => {
  it('is 404 with federation off', async () => {
    const res = await onRequestDelete(ctx(PEER_ID, { env: { ...env, FEDERATION_ENABLED: 'false' } }))
    expect(res.status).toBe(404)
  })

  it('is 403 for a non-admin', async () => {
    expect((await onRequestDelete(ctx(PEER_ID, { publisher: PUBLISHER }))).status).toBe(403)
  })

  it('is 404 for an unknown peer', async () => {
    const res = await onRequestDelete(ctx('01J0000000000000000000NOPE'))
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'peer_not_found' })
  })

  it('removes the peer and audits it', async () => {
    const res = await onRequestDelete(ctx(PEER_ID))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: true, removed_rows: 0 })
    expect(sqlite.prepare('SELECT id FROM federation_peers').all()).toEqual([])
    const audit = sqlite.prepare("SELECT subject_id FROM audit_events WHERE action = 'federation_peer.remove'").all()
    expect(audit).toEqual([{ subject_id: PEER_ID }])
  })
})
