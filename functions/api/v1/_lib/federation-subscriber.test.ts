// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { generateKeyPairSync } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { freshMigratedDb } from '../../../../scripts/lib/catalog-migrations'
import { asD1 } from './test-helpers'
import { encodeFeedCursor } from './federation-feed'
import {
  SIGNATURE_HEADER,
  importNodeSigningKey,
  signFederationBody,
} from './federation-signature'
import { d1FederationMirrorStore, d1FederationPeerStore } from './federation-mirror-d1'
import {
  DISCOVERY_MAX_BYTES,
  feedTarget,
  fetchPeerDiscovery,
  isFederationId,
  parsePeerBaseUrl,
  pullPeer,
  type FederationPeer,
  type PullDeps,
} from './federation-subscriber'

const PEER_ID = '01J00000000000000000000PEER'
const BASE = 'https://peer.example.org'
const NOW_MS = 1_790_000_000_000

function genKeys(): { privateB64: string; publicWire: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer
  return {
    privateB64: pkcs8.toString('base64'),
    publicWire: `ed25519:${spki.subarray(spki.length - 32).toString('base64')}`,
  }
}

const PEER_KEYS = genKeys()
const OTHER_KEYS = genKeys()

const cursor = (n: number) => encodeFeedCursor({ updatedAt: `2026-01-0${n}T00:00:00.000Z`, id: `d${n}` })

function page(over: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    node_id: PEER_ID,
    generated_at: '2026-01-09T00:00:00.000Z',
    cursor: cursor(1),
    has_more: false,
    datasets: [] as unknown[],
    tombstones: [] as string[],
    ...over,
  }
}

const ds = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Dataset ${id}`,
  originNode: PEER_ID,
  ...extra,
})

type Reply =
  | { body: unknown; signTarget?: string; keyB64?: string; signer?: string }
  | { response: Response }

/** A peer that answers each request from `handler`, signing what it
 *  returns for the target it was asked (unless told otherwise). */
function fakePeer(handler: (target: string) => Reply) {
  const targets: string[] = []
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    expect(url.origin).toBe(BASE)
    expect(init?.redirect).toBe('manual')
    const target = url.pathname + url.search
    targets.push(target)
    const reply = handler(target)
    if ('response' in reply) return reply.response
    const key = await importNodeSigningKey(reply.keyB64 ?? PEER_KEYS.privateB64)
    const signed = await signFederationBody(reply.body, key, {
      keyId: reply.signer ?? PEER_ID,
      created: Math.floor(NOW_MS / 1000),
      target: reply.signTarget ?? target,
    })
    return new Response(signed.text, {
      status: 200,
      headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signed.header },
    })
  })
  return { fetchFn: fetchFn as unknown as typeof fetch, targets, calls: fetchFn }
}

let db: D1Database
let runs: number

beforeEach(async () => {
  db = asD1(freshMigratedDb())
  runs = 0
  await d1FederationPeerStore(db).addPeer(
    { id: PEER_ID, baseUrl: BASE, displayName: 'Peer', publicKey: PEER_KEYS.publicWire },
    '2026-01-01T00:00:00.000Z',
  )
})

async function peer(): Promise<FederationPeer> {
  return (await d1FederationPeerStore(db).getPeer(PEER_ID))!
}

function deps(fetchFn: typeof fetch): PullDeps {
  return {
    fetch: fetchFn,
    store: d1FederationMirrorStore(db),
    now: () => NOW_MS,
    newRunId: () => `run-${++runs}`,
  }
}

async function mirrored(): Promise<Array<{ remote_id: string; origin_node: string; seen_run: string }>> {
  const r = await db
    .prepare('SELECT remote_id, origin_node, seen_run FROM federated_datasets ORDER BY remote_id')
    .all<{ remote_id: string; origin_node: string; seen_run: string }>()
  return r.results ?? []
}

async function seedMirrored(remoteId: string, run: string) {
  await db
    .prepare(
      `INSERT INTO federated_datasets
         (peer_id, remote_id, origin_node, payload_json, feed_signature, seen_run, fetched_at)
       VALUES (?, ?, ?, '{}', 'sig', ?, '2026-01-01T00:00:00.000Z')`,
    )
    .bind(PEER_ID, remoteId, PEER_ID, run)
    .run()
}

describe('parsePeerBaseUrl', () => {
  it.each([
    ['https://peer.example.org', 'https://peer.example.org'],
    ['https://peer.example.org/', 'https://peer.example.org'],
    ['https://peer.example.org:8443', 'https://peer.example.org:8443'],
    ['HTTPS://Peer.Example.org', 'https://peer.example.org'],
  ])('accepts %s', (raw, origin) => {
    expect(parsePeerBaseUrl(raw)).toBe(origin)
  })

  it.each([
    'http://peer.example.org',
    'https://user:pw@peer.example.org',
    'https://peer.example.org/catalog',
    'https://peer.example.org/?x=1',
    'https://peer.example.org/#frag',
    'https://peer.example.org?',
    'https://localhost',
    'https://intranet',
    'https://127.0.0.1',
    'https://[::1]',
    'https://foo.localhost',
    'not a url',
    '',
  ])('refuses %s', raw => {
    expect(parsePeerBaseUrl(raw)).toBeNull()
  })
})

describe('feedTarget', () => {
  it('omits since without a cursor and encodes it with one', () => {
    expect(feedTarget(null, 100)).toBe('/api/v1/federation/feed?limit=100')
    expect(feedTarget('v1.ab-_', 50)).toBe('/api/v1/federation/feed?since=v1.ab-_&limit=50')
  })
})

describe('pullPeer', () => {
  it('runs a first pull as a full sync across pages and reconciles', async () => {
    await seedMirrored('gone', 'old-run')
    const { fetchFn, targets } = fakePeer(target => {
      if (!target.includes('since=')) {
        return { body: page({ cursor: cursor(1), has_more: true, datasets: [ds('a'), ds('b')] }) }
      }
      return { body: page({ cursor: cursor(2), has_more: false, datasets: [ds('c', { originNode: 'OTHERNODE' })] }) }
    })

    const result = await pullPeer(await peer(), deps(fetchFn))

    expect(result).toMatchObject({ ok: true, full: true, complete: true, pages: 2, upserted: 3, reconciled: 1 })
    expect(targets).toEqual([
      '/api/v1/federation/feed?limit=100',
      `/api/v1/federation/feed?since=${cursor(1)}&limit=100`,
    ])
    expect(await mirrored()).toEqual([
      { remote_id: 'a', origin_node: PEER_ID, seen_run: 'run-1' },
      { remote_id: 'b', origin_node: PEER_ID, seen_run: 'run-1' },
      { remote_id: 'c', origin_node: 'OTHERNODE', seen_run: 'run-1' },
    ])
    const p = await peer()
    expect(p.lastSyncCursor).toBe(cursor(2))
    expect(p.fullSyncRun).toBeNull()
    expect(p.lastSyncError).toBeNull()
    expect(p.lastSyncAt).toBe(new Date(NOW_MS).toISOString())
  })

  it('pulls incrementally from the stored cursor, applying tombstones without reconciling', async () => {
    await db
      .prepare('UPDATE federation_peers SET last_sync_cursor = ? WHERE id = ?')
      .bind(cursor(3), PEER_ID)
      .run()
    await seedMirrored('keep', 'old-run')
    await seedMirrored('retracted', 'old-run')
    const { fetchFn, targets } = fakePeer(() => ({
      body: page({ cursor: cursor(4), datasets: [ds('new')], tombstones: ['retracted'] }),
    }))

    const result = await pullPeer(await peer(), deps(fetchFn))

    expect(result).toMatchObject({ ok: true, full: false, upserted: 1, tombstoned: 1, reconciled: 0 })
    expect(targets).toEqual([`/api/v1/federation/feed?since=${cursor(3)}&limit=100`])
    expect((await mirrored()).map(r => r.remote_id)).toEqual(['keep', 'new'])
    expect((await peer()).lastSyncCursor).toBe(cursor(4))
  })

  it('restarts from the beginning when a full sync is asked for', async () => {
    await db
      .prepare('UPDATE federation_peers SET last_sync_cursor = ? WHERE id = ?')
      .bind(cursor(3), PEER_ID)
      .run()
    await seedMirrored('gone', 'old-run')
    const { fetchFn, targets } = fakePeer(() => ({ body: page({ datasets: [ds('a')] }) }))

    const result = await pullPeer(await peer(), deps(fetchFn), { full: true })

    expect(result).toMatchObject({ ok: true, full: true, reconciled: 1 })
    expect(targets).toEqual(['/api/v1/federation/feed?limit=100'])
    expect((await mirrored()).map(r => r.remote_id)).toEqual(['a'])
  })

  it('carries a full sync cut short by the page cap into the next pull, then reconciles', async () => {
    await seedMirrored('gone', 'old-run')
    let served = 0
    const { fetchFn } = fakePeer(() => {
      served++
      return {
        body: page({ cursor: cursor(served), has_more: served < 3, datasets: [ds(`d${served}`)] }),
      }
    })

    const first = await pullPeer(await peer(), deps(fetchFn), { maxPages: 2 })
    expect(first).toMatchObject({ ok: true, full: true, complete: false, pages: 2, reconciled: 0 })
    expect((await peer()).fullSyncRun).toBe('run-1')
    // Not reconciled yet: a partial view must not drop rows.
    expect((await mirrored()).map(r => r.remote_id)).toContain('gone')

    const second = await pullPeer(await peer(), deps(fetchFn), { maxPages: 2 })
    expect(second).toMatchObject({ ok: true, full: true, complete: true, pages: 1, reconciled: 1 })
    expect(runs).toBe(1)
    expect((await mirrored()).map(r => r.remote_id)).toEqual(['d1', 'd2', 'd3'])
    expect((await peer()).fullSyncRun).toBeNull()
  })

  it('keeps pages already applied when a later page fails, and does not reconcile', async () => {
    await seedMirrored('gone', 'old-run')
    const { fetchFn } = fakePeer(target =>
      target.includes('since=')
        ? { response: new Response('nope', { status: 503 }) }
        : { body: page({ has_more: true, datasets: [ds('a')] }) },
    )

    const result = await pullPeer(await peer(), deps(fetchFn))

    expect(result).toMatchObject({ ok: false, error: 'http-status', status: 503, pages: 1, reconciled: 0 })
    expect((await mirrored()).map(r => r.remote_id)).toEqual(['a', 'gone'])
    const p = await peer()
    expect(p.lastSyncCursor).toBe(cursor(1))
    expect(p.fullSyncRun).toBe('run-1')
    expect(p.lastSyncError).toBe('http-status:503')
  })

  describe('refuses a page and applies nothing', () => {
    async function expectRefused(reply: Reply, error: string, opts = {}) {
      const { fetchFn } = fakePeer(() => reply)
      const result = await pullPeer(await peer(), deps(fetchFn), opts)
      expect(result).toMatchObject({ ok: false, error, pages: 0 })
      expect(await mirrored()).toEqual([])
      const p = await peer()
      expect(p.lastSyncCursor).toBeNull()
      expect(p.lastSyncError).toBe(error)
    }

    it('signed by another key', () =>
      expectRefused({ body: page({ datasets: [ds('a')] }), keyB64: OTHER_KEYS.privateB64 }, 'bad-signature'))

    it('signed for another request', () =>
      expectRefused(
        { body: page({ datasets: [ds('a')] }), signTarget: '/api/v1/federation/feed?limit=250' },
        'bad-signature',
      ))

    it('signed under another key id', () =>
      expectRefused({ body: page(), signer: 'SOMEONEELSE' }, 'key-mismatch'))

    it('naming another node in the body', () =>
      expectRefused({ body: page({ node_id: 'SOMEONEELSE' }) }, 'node-mismatch'))

    it('with a schema version this build does not know', () =>
      expectRefused({ body: page({ schema_version: 2 }) }, 'unsupported-version'))

    it('with a malformed cursor', () =>
      expectRefused({ body: page({ cursor: 'not-a-cursor' }) }, 'invalid-body'))

    it('with an id both upserted and tombstoned', () =>
      expectRefused({ body: page({ datasets: [ds('a')], tombstones: ['a'] }) }, 'invalid-body'))

    it('with a dataset id outside the alphabet', () =>
      expectRefused({ body: page({ datasets: [ds('../a')] }) }, 'invalid-body'))

    it('larger than the body cap', () =>
      expectRefused({ body: page({ datasets: [ds('a', { description: 'x'.repeat(4096) })] }) }, 'too-large', {
        maxBodyBytes: 1024,
      }))

    it('with no signature header', () =>
      expectRefused(
        { response: new Response(JSON.stringify(page()), { status: 200 }) },
        'missing-header',
      ))

    it('that redirects', async () => {
      const { fetchFn } = fakePeer(() => ({
        response: new Response(null, { status: 302, headers: { location: 'https://elsewhere.example' } }),
      }))
      const result = await pullPeer(await peer(), deps(fetchFn))
      expect(result).toMatchObject({ ok: false, error: 'redirect', status: 302 })
      expect((await peer()).lastSyncError).toBe('redirect:302')
    })
  })

  it('reports a network failure', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const result = await pullPeer(await peer(), deps(fetchFn))
    expect(result).toMatchObject({ ok: false, error: 'network' })
    expect((await peer()).lastSyncError).toBe('network')
  })

  it('does not fetch from a peer that is not active', async () => {
    await db.prepare("UPDATE federation_peers SET status = 'paused' WHERE id = ?").bind(PEER_ID).run()
    const { fetchFn, calls } = fakePeer(() => ({ body: page() }))
    const result = await pullPeer(await peer(), deps(fetchFn))
    expect(result).toMatchObject({ ok: false, error: 'peer-not-active' })
    expect(calls).not.toHaveBeenCalled()
    expect((await peer()).lastSyncError).toBeNull()
  })

  it('refuses a peer record whose base URL or key is unusable', async () => {
    const { fetchFn, calls } = fakePeer(() => ({ body: page() }))
    const bad = { ...(await peer()), publicKey: 'ed25519:short' }
    const result = await pullPeer(bad, deps(fetchFn))
    expect(result).toMatchObject({ ok: false, error: 'bad-peer' })
    expect(calls).not.toHaveBeenCalled()
  })
})

describe('d1FederationPeerStore', () => {
  it('refuses a second peer with the same id or base URL', async () => {
    const store = d1FederationPeerStore(db)
    const now = '2026-01-02T00:00:00.000Z'
    expect(
      await store.addPeer({ id: PEER_ID, baseUrl: 'https://x.example.org', displayName: 'X', publicKey: OTHER_KEYS.publicWire }, now),
    ).toBe('exists')
    expect(
      await store.addPeer({ id: 'OTHERPEER', baseUrl: BASE, displayName: 'X', publicKey: OTHER_KEYS.publicWire }, now),
    ).toBe('exists')
    expect(
      await store.addPeer({ id: 'OTHERPEER', baseUrl: 'https://x.example.org', displayName: 'X', publicKey: OTHER_KEYS.publicWire }, now),
    ).toBe('added')
    await seedMirrored('a', 'r')
    const listed = await store.listPeers()
    expect(listed.map(p => [p.id, p.mirroredCount])).toEqual([
      [PEER_ID, 1],
      ['OTHERPEER', 0],
    ])
  })
})

describe('isFederationId', () => {
  it('admits ids and refuses anything that could reshape a path or header', () => {
    expect(isFederationId(PEER_ID)).toBe(true)
    expect(isFederationId('node.example:1')).toBe(true)
    expect(isFederationId('')).toBe(false)
    expect(isFederationId('a b')).toBe(false)
    expect(isFederationId('a/b')).toBe(false)
    expect(isFederationId('x'.repeat(129))).toBe(false)
  })
})

describe('fetchPeerDiscovery', () => {
  const doc = (over: Record<string, unknown> = {}) => ({
    node_id: PEER_ID,
    display_name: 'Peer node',
    base_url: BASE,
    public_key: PEER_KEYS.publicWire,
    federation: { feed: true },
    ...over,
  })
  const serving = (res: Response) => {
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${BASE}/.well-known/terraviz.json`)
      expect(init?.redirect).toBe('manual')
      return res
    })
    return fn as unknown as typeof fetch
  }
  const jsonRes = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

  it('reads the claims, normalizing the base URL', async () => {
    const result = await fetchPeerDiscovery(serving(jsonRes(doc({ base_url: `${BASE}/` }))), BASE)
    expect(result).toEqual({
      ok: true,
      doc: { nodeId: PEER_ID, displayName: 'Peer node', baseUrl: BASE, publicKey: PEER_KEYS.publicWire, feed: true },
    })
  })

  it('reads a node that predates the feed field as not serving one', async () => {
    const { federation: _omit, ...old } = doc()
    const result = await fetchPeerDiscovery(serving(jsonRes(old)), BASE)
    expect(result).toMatchObject({ ok: true, doc: { feed: false } })
  })

  it('refuses a redirect', async () => {
    const res = new Response(null, { status: 301, headers: { location: 'https://elsewhere.example.org/' } })
    expect(await fetchPeerDiscovery(serving(res), BASE)).toEqual({ ok: false, error: 'redirect', status: 301 })
  })

  it('refuses a document over the byte cap', async () => {
    const res = jsonRes(doc({ display_name: 'x'.repeat(DISCOVERY_MAX_BYTES) }))
    expect(await fetchPeerDiscovery(serving(res), BASE)).toEqual({ ok: false, error: 'too-large' })
  })

  it('refuses a document whose id or base URL is malformed', async () => {
    for (const bad of [doc({ node_id: 'a/b' }), doc({ base_url: 'http://peer.example.org' }), doc({ public_key: 7 }), [doc()]]) {
      expect(await fetchPeerDiscovery(serving(jsonRes(bad)), BASE)).toEqual({ ok: false, error: 'invalid-body' })
    }
    const notJson = new Response('<html>', { status: 200 })
    expect(await fetchPeerDiscovery(serving(notJson), BASE)).toEqual({ ok: false, error: 'invalid-body' })
  })

  it('reports a non-200 status', async () => {
    expect(await fetchPeerDiscovery(serving(new Response('no', { status: 404 })), BASE)).toEqual({
      ok: false,
      error: 'http-status',
      status: 404,
    })
  })
})
