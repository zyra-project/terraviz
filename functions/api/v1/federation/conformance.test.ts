// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

// @vitest-environment node

/**
 * Phase 5 conformance: one node's real feed route, pulled by another
 * node's real subscriber engine, each on its own migrated SQLite
 * catalog. Nothing between them is stubbed except the network, which
 * routes the subscriber's request to the publisher's handler.
 *
 * What this pins is that the two halves agree: a full sync mirrors
 * exactly the rows the publisher's feed lists, an incremental pull
 * applies a tombstone, and a page altered in transit or signed by a
 * key other than the pinned one changes nothing.
 *
 * Run alone with `npm run test:federation`.
 */

import { generateKeyPairSync } from 'node:crypto'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestGet, resetFeedSigningKeyCache } from './feed'
import { asD1, makeCtx, seedFixtures } from '../_lib/test-helpers'
import { d1FederationMirrorStore, d1FederationPeerStore } from '../_lib/federation-mirror-d1'
import { pullPeer, type PullOptions } from '../_lib/federation-subscriber'

const ORIGIN = 'https://publisher.example.org'
const NOW = new Date('2026-02-01T00:00:00.000Z')

function makeKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const secret = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string }
  return { secret, wire: `ed25519:${Buffer.from(jwk.x, 'base64url').toString('base64')}` }
}

const KEYS = makeKeyPair()
const OTHER = makeKeyPair()
const idOf = (i: number) => `DS${String(i).padStart(3, '0')}` + 'A'.repeat(21)

let publisher: Database.Database
let publisherEnv: Record<string, unknown>
let subscriber: Database.Database
let tamper: ((text: string) => string) | null

/** The network: every subscriber request lands on the publisher's handler. */
const network: typeof fetch = async (input, init) => {
  expect(init?.redirect).toBe('manual')
  const url = String(input)
  expect(url.startsWith(`${ORIGIN}/api/v1/federation/feed`)).toBe(true)
  const res = await onRequestGet(makeCtx({ url, env: publisherEnv }))
  if (!tamper) return res
  return new Response(tamper(await res.text()), { status: res.status, headers: res.headers })
}

async function addPeer(publicKey = KEYS.wire) {
  await d1FederationPeerStore(asD1(subscriber)).addPeer(
    { id: 'NODE000', baseUrl: ORIGIN, displayName: 'Publisher', publicKey },
    NOW.toISOString(),
  )
}

async function pull(opts: PullOptions = {}) {
  const peer = await d1FederationPeerStore(asD1(subscriber)).getPeer('NODE000')
  if (!peer) throw new Error('peer missing')
  let run = 0
  return pullPeer(
    peer,
    {
      fetch: network,
      store: d1FederationMirrorStore(asD1(subscriber)),
      now: () => Date.now(),
      newRunId: () => `RUN${++run}${Date.now()}`,
    },
    opts,
  )
}

const mirrored = () =>
  (
    subscriber.prepare('SELECT remote_id, origin_node FROM federated_datasets ORDER BY remote_id').all() as Array<{
      remote_id: string
      origin_node: string
    }>
  )

/** Every id the publisher's feed lists, read straight off the route. */
async function feedIds(): Promise<string[]> {
  const ids: string[] = []
  let query = '?limit=250'
  for (;;) {
    const res = await onRequestGet(makeCtx({ url: `${ORIGIN}/api/v1/federation/feed${query}`, env: publisherEnv }))
    const body = (await res.json()) as { datasets: Array<{ id: string }>; cursor: string; has_more: boolean }
    ids.push(...body.datasets.map(d => d.id))
    if (!body.has_more) return ids.sort()
    query = `?limit=250&since=${encodeURIComponent(body.cursor)}`
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  resetFeedSigningKeyCache()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  tamper = null
  publisher = seedFixtures({ count: 7 })
  publisher.prepare('UPDATE node_identity SET public_key = ?').run(KEYS.wire)
  publisherEnv = {
    CATALOG_DB: asD1(publisher),
    FEDERATION_ENABLED: 'true',
    FEDERATION_ABUSE_CONTACT: 'abuse@test.local',
    NODE_ID_PRIVATE_KEY_PEM: KEYS.secret,
  }
  subscriber = seedFixtures({ count: 0 })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('federation conformance: feed route ↔ subscriber engine', () => {
  it('a full sync over several pages mirrors exactly what the feed lists', async () => {
    publisher.prepare('UPDATE datasets SET is_hidden = 1 WHERE id = ?').run(idOf(4))
    await addPeer()
    const expected = await feedIds()
    expect(expected.length).toBeGreaterThan(2)
    expect(expected).not.toContain(idOf(4))

    const result = await pull({ pageLimit: 2 })
    expect(result).toMatchObject({ ok: true, full: true, complete: true })
    expect(result.pages).toBeGreaterThan(1)
    expect(mirrored().map(r => r.remote_id)).toEqual(expected)
    expect(new Set(mirrored().map(r => r.origin_node))).toEqual(new Set(['NODE000']))
  })

  it('an incremental pull applies a tombstone the publisher emits', async () => {
    await addPeer()
    expect((await pull()).ok).toBe(true)
    expect(mirrored().map(r => r.remote_id)).toContain(idOf(1))

    vi.setSystemTime(new Date('2026-02-02T00:00:00.000Z'))
    publisher
      .prepare("UPDATE datasets SET is_hidden = 1, updated_at = '2026-02-01T12:00:00.000Z' WHERE id = ?")
      .run(idOf(1))
    const result = await pull()
    expect(result).toMatchObject({ ok: true, full: false, tombstoned: 1 })
    expect(mirrored().map(r => r.remote_id)).not.toContain(idOf(1))
    expect(mirrored().map(r => r.remote_id)).toEqual(await feedIds())
  })

  it('a page altered in transit fails verification and changes nothing', async () => {
    await addPeer()
    tamper = text => {
      const body = JSON.parse(text) as { datasets: Array<{ title: string }> }
      body.datasets[0].title = 'Altered'
      return JSON.stringify(body)
    }
    const result = await pull()
    expect(result.ok).toBe(false)
    expect(result.error).toBe('bad-signature')
    expect(mirrored()).toEqual([])
  })

  it('a peer pinned to another key fails verification and changes nothing', async () => {
    await addPeer(OTHER.wire)
    const result = await pull()
    expect(result.ok).toBe(false)
    expect(result.error).toBe('bad-signature')
    expect(mirrored()).toEqual([])
  })
})
