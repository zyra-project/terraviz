// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project
// @vitest-environment node

/**
 * GET /api/v1/federation/feed against a migrated SQLite catalog: the
 * flag, every refusal, and a signed page a peer can verify — with the
 * scan's edges (drafts, private rows, tombstones, the settle window,
 * ties on `updated_at`) checked through the real D1 store.
 */

import { generateKeyPairSync } from 'node:crypto'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequest, onRequestGet, resetFeedSigningKeyCache, wellFormed, feedRateKey } from './feed'
import { onRequest as unimplemented } from './[[path]]'
import { asD1, makeCtx, seedFixtures } from '../_lib/test-helpers'
import { encodeFeedCursor, type FederationFeedBody } from '../_lib/federation-feed'
import { SIGNATURE_HEADER, verifyFederationBody, importNodePublicKey } from '../_lib/federation-signature'

const NOW = new Date('2026-02-01T00:00:00.000Z')
const BASE = 'https://test.local/api/v1/federation/feed'

function makeKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const secret = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string }
  const wire = `ed25519:${Buffer.from(jwk.x, 'base64url').toString('base64')}`
  return { secret, wire }
}

const KEYS = makeKeyPair()

function setup(count = 3): { sqlite: Database.Database; env: Record<string, unknown> } {
  const sqlite = seedFixtures({ count })
  sqlite.prepare('UPDATE node_identity SET public_key = ?').run(KEYS.wire)
  return {
    sqlite,
    env: {
      CATALOG_DB: asD1(sqlite),
      FEDERATION_ENABLED: 'true',
      FEDERATION_ABUSE_CONTACT: 'abuse@test.local',
      NODE_ID_PRIVATE_KEY_PEM: KEYS.secret,
    },
  }
}

const idOf = (i: number) => `DS${String(i).padStart(3, '0')}` + 'A'.repeat(21)

async function get(env: Record<string, unknown>, query = '') {
  return onRequestGet(makeCtx({ url: BASE + query, env }))
}

async function verified(res: Response, query = '') {
  const text = await res.text()
  const result = await verifyFederationBody(text, res.headers.get(SIGNATURE_HEADER), {
    publicKey: await importNodePublicKey(KEYS.wire),
    expectedKeyId: 'NODE000',
    expectedTarget: '/api/v1/federation/feed' + query,
    now: Math.floor(NOW.getTime() / 1000),
  })
  if (!result.ok) throw new Error(`signature did not verify: ${result.reason}`)
  return result.body as FederationFeedBody
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  resetFeedSigningKeyCache()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('feed rate keys', () => {
  it('groups equivalent IPv6 addresses by /64', () => {
    expect(feedRateKey('2001:db8::1')).toBe(feedRateKey('2001:0db8:0:0:abcd::1'))
    expect(feedRateKey('2001:db8:0:1::1')).not.toBe(feedRateKey('2001:db8::1'))
    expect(feedRateKey('192.0.2.1')).toBe('192.0.2.1')
  })

  // Every IPv4-mapped address shares the /64 `0:0:0:0`, so bucketing
  // them by prefix would put every such client in one bucket.
  it('keys an IPv4-mapped address as the IPv4 address it carries', () => {
    expect(feedRateKey('::ffff:192.0.2.1')).toBe('192.0.2.1')
    expect(feedRateKey('::ffff:c000:201')).toBe('192.0.2.1')
    expect(feedRateKey('::ffff:198.51.100.7')).toBe('198.51.100.7')
    // Only the IPv4-mapped prefix: an IPv6 host choosing `ffff` in its
    // own interface id stays in its /64.
    expect(feedRateKey('2001:db8::ffff:c000:201')).toBe('2001:db8:0:0::/64')
  })
})

describe('GET /api/v1/federation/feed — refusals', () => {
  it('returns JSON for storage errors', async () => {
    const { env } = setup()
    const res = await get({ ...env, CATALOG_DB: { prepare() { throw new Error('D1 failure') } } })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'feed_unavailable' })
  })

  it('handles HEAD and refuses unsupported methods', async () => {
    const { env } = setup()
    const head = await onRequest(makeCtx({ url: BASE, method: 'HEAD', env }))
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    const post = await onRequest(makeCtx({ url: BASE, method: 'POST', env }))
    expect(post.status).toBe(405)
    expect(post.headers.get('allow')).toBe('GET, HEAD')
    expect(await post.json()).toEqual({ error: 'method_not_allowed' })
  })

  it('keeps disabled HEAD and unimplemented federation paths JSON 404', async () => {
    const head = await onRequest(makeCtx({ url: BASE, method: 'HEAD', env: { FEDERATION_ENABLED: 'false' } }))
    expect(head.status).toBe(404)
    expect(head.headers.get('content-type')).toContain('application/json')
    expect(await head.text()).toBe('')
    for (const method of ['GET', 'HEAD', 'POST']) {
      const response = await unimplemented(makeCtx({ url: BASE.replace('/feed', '/handshake'), method, env: {} }))
      expect(response.status).toBe(404)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.text()).toBe(method === 'HEAD' ? '' : '{"error":"not_found"}')
    }
  })

  it('limits requests before querying D1 regardless of cursor', async () => {
    const { env } = setup()
    for (let request = 0; request < 600; request++) {
      expect((await get(env, '?since=invalid' + request)).status).toBe(400)
    }
    const response = await get(env)
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('60')
    vi.setSystemTime(new Date(NOW.getTime() + 60_000))
    expect((await get(env)).status).toBe(200)
  })

  it.each([undefined, 'false', 'TRUE', '1'])('is 404 when FEDERATION_ENABLED is %j', async flag => {
    const { env } = setup()
    const res = await get({ ...env, FEDERATION_ENABLED: flag })
    expect(res.status).toBe(404)
    expect(res.headers.get(SIGNATURE_HEADER)).toBeNull()
    expect(await res.json()).toEqual({ error: 'not_found' })
  })

  it.each([undefined, '', 'not an address', 'Abuse <abuse@test.local>'])(
    'is 503 when switched on with FEDERATION_ABUSE_CONTACT %j',
    async contact => {
      const { env } = setup()
      const res = await get({ ...env, FEDERATION_ABUSE_CONTACT: contact })
      expect(res.status).toBe(503)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get(SIGNATURE_HEADER)).toBeNull()
      expect(((await res.json()) as { error: string }).error).toBe('abuse_contact_missing')
    },
  )

  it('is still 404 when switched off, whatever the abuse contact', async () => {
    const { env } = setup()
    const res = await get({ ...env, FEDERATION_ENABLED: 'false', FEDERATION_ABUSE_CONTACT: undefined })
    expect(res.status).toBe(404)
  })

  it('is 503 without a catalog database', async () => {
    const res = await get({ FEDERATION_ENABLED: 'true', FEDERATION_ABUSE_CONTACT: 'abuse@test.local' })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toBe('binding_missing')
  })

  it.each([
    ['?page=2', 'unknown_parameter'],
    ['?since=x&cursor=y', 'unknown_parameter'],
    ['?limit=5&limit=6', 'duplicate_parameter'],
    ['?since=nope', 'invalid_cursor'],
    ['?since=', 'invalid_cursor'],
    ['?limit=0', 'invalid_limit'],
    ['?limit=251', 'invalid_limit'],
    ['?limit=01', 'invalid_limit'],
    ['?limit=abc', 'invalid_limit'],
    // Signed as it arrived, so only the plain spelling is served.
    ['?limit=5&', 'invalid_query'],
    ['?l%69mit=5', 'invalid_query'],
    ['?limit=5' + '&'.repeat(3000), 'invalid_query'],
  ])('is 400 for %s', async (query, code) => {
    const { env } = setup()
    const res = await get(env, query)
    expect(res.status).toBe(400)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(((await res.json()) as { error: string }).error).toBe(code)
  })

  it('is 503 before the node has an identity', async () => {
    const { sqlite, env } = setup()
    sqlite.prepare('DELETE FROM node_identity').run()
    const res = await get(env)
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toBe('identity_missing')
  })

  it.each([
    ['missing', undefined],
    ['not a key', 'bm90IGEga2V5'],
    ['not base64', '!!!'],
    ['another node’s key', makeKeyPair().secret],
  ])('is 503 when the signing key is %s', async (_name, secret) => {
    const { env } = setup()
    const res = await get({ ...env, NODE_ID_PRIVATE_KEY_PEM: secret })
    expect(res.status).toBe(503)
    expect(res.headers.get(SIGNATURE_HEADER)).toBeNull()
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('signing_key_unavailable')
    expect(JSON.stringify(body)).not.toContain(KEYS.secret)
  })

  it('notices a rotated public key on the next request', async () => {
    const { sqlite, env } = setup()
    expect((await get(env)).status).toBe(200)
    sqlite.prepare('UPDATE node_identity SET public_key = ?').run(makeKeyPair().wire)
    expect((await get(env)).status).toBe(503)
  })
})

describe('GET /api/v1/federation/feed — pages', () => {
  it('serves a signed page a peer can verify', async () => {
    const { env } = setup()
    const res = await get(env)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await verified(res)
    expect(body.schema_version).toBe(1)
    expect(body.node_id).toBe('NODE000')
    expect(body.generated_at).toBe('2026-01-31T23:59:30.000Z')
    expect(body.has_more).toBe(false)
    expect(body.datasets.map(d => d.id)).toEqual([idOf(0), idOf(1), idOf(2)])
    expect(body.datasets[0].originNode).toBe('NODE000')
    expect(body.tombstones).toEqual([])
  })

  it('excludes foreign-origin datasets and tombstones', async () => {
    const { sqlite, env } = setup(3)
    sqlite.prepare("UPDATE datasets SET origin_node = 'OTHER' WHERE id = ?").run(idOf(0))
    sqlite.prepare("UPDATE datasets SET origin_node = 'OTHER', retracted_at = '2026-01-20T00:00:00.000Z' WHERE id = ?").run(idOf(1))
    const body = await verified(await get(env))
    expect(body.datasets.map(d => d.id)).toEqual([idOf(2)])
    expect(body.tombstones).toEqual([])
  })

  it('signs the query it was asked, so a page cannot be replayed for another', async () => {
    const { env } = setup()
    const res = await get(env, '?limit=2')
    const text = await res.text()
    const result = await verifyFederationBody(text, res.headers.get(SIGNATURE_HEADER), {
      publicKey: await importNodePublicKey(KEYS.wire),
      expectedKeyId: 'NODE000',
      expectedTarget: '/api/v1/federation/feed',
      now: Math.floor(NOW.getTime() / 1000),
    })
    expect(result).toEqual({ ok: false, reason: 'bad-signature' })
  })

  it('signs a row whose text holds a lone surrogate, replacing it', async () => {
    expect(wellFormed({ title: 'bad \uD800 title' })).toEqual({ title: 'bad \uFFFD title' })
    const { env } = setup()
    const res = await get(env)
    expect(res.status).toBe(200)
    await verified(res)
  })

  it('leaves out drafts, non-public and hidden rows, and tombstones retracted ones', async () => {
    const { sqlite, env } = setup(6)
    sqlite.prepare('UPDATE datasets SET published_at = NULL WHERE id = ?').run(idOf(0))
    sqlite.prepare("UPDATE datasets SET visibility = 'private' WHERE id = ?").run(idOf(1))
    sqlite.prepare('UPDATE datasets SET is_hidden = 1 WHERE id = ?').run(idOf(2))
    sqlite.prepare("UPDATE datasets SET retracted_at = '2026-01-20T00:00:00.000Z' WHERE id = ?").run(idOf(3))
    const body = await verified(await get(env))
    expect(body.datasets.map(d => d.id)).toEqual([idOf(4), idOf(5)])
    expect(body.tombstones).toEqual([idOf(3)])
    const text = JSON.stringify(body)
    expect(text).not.toContain(idOf(0))
    expect(text).not.toContain(idOf(1))
    expect(text).not.toContain(idOf(2))
  })

  it.each(['{"x":1e999}', '['.repeat(70) + '0' + ']'.repeat(70), '{"__proto__":{"a":1}}'])(
    'does not stall on probing metadata %s', async probing => {
      const { sqlite, env } = setup()
      sqlite.prepare('UPDATE datasets SET probing_info = ? WHERE id = ?').run(probing, idOf(0))
      const body = await verified(await get(env))
      expect(body.datasets.map(dataset => dataset.id)).toContain(idOf(0))
    },
  )

  it('pages through rows that share an updated_at', async () => {
    const { sqlite, env } = setup(5)
    sqlite.prepare("UPDATE datasets SET updated_at = '2026-01-10T00:00:00.000Z'").run()
    const seen: string[] = []
    let query = '?limit=2'
    for (let i = 0; i < 10; i++) {
      const body = await verified(await get(env, query), query)
      seen.push(...body.datasets.map(d => d.id))
      query = `?since=${body.cursor}&limit=2`
      if (!body.has_more) break
    }
    expect(seen).toEqual([0, 1, 2, 3, 4].map(idOf))
  })

  it('holds back a row inside the settle window until it has settled', async () => {
    const { sqlite, env } = setup(2)
    sqlite.prepare("UPDATE datasets SET updated_at = '2026-01-31T23:59:50.000Z' WHERE id = ?").run(idOf(1))
    const first = await verified(await get(env))
    expect(first.datasets.map(d => d.id)).toEqual([idOf(0)])

    vi.setSystemTime(new Date(NOW.getTime() + 60_000))
    const query = `?since=${first.cursor}`
    const res = await get(env, query)
    const text = await res.text()
    const result = await verifyFederationBody(text, res.headers.get(SIGNATURE_HEADER), {
      publicKey: await importNodePublicKey(KEYS.wire),
      expectedKeyId: 'NODE000',
      expectedTarget: '/api/v1/federation/feed' + query,
      now: Math.floor(NOW.getTime() / 1000) + 60,
    })
    expect(result.ok).toBe(true)
    expect((result as { body: FederationFeedBody }).body.datasets.map(d => d.id)).toEqual([idOf(1)])
  })

  it.each([60, 61, 62, 63, 64])('keeps rows reachable with probing metadata nested %i levels', async depth => {
    const { sqlite, env } = setup(2)
    let probing: unknown = 1
    for (let level = 0; level < depth; level++) probing = [probing]
    sqlite.prepare('UPDATE datasets SET probing_info = ? WHERE id = ?').run(JSON.stringify(probing), idOf(0))
    const body = await verified(await get(env))
    expect(body.datasets.map(dataset => dataset.id)).toEqual([idOf(0), idOf(1)])
    expect(body.datasets[0].probingInfo).toEqual(depth <= 60 ? probing : undefined)
  })

  it('answers a cursor ahead of the feed with an empty page that keeps it', async () => {
    const { env } = setup()
    const ahead = encodeFeedCursor({ updatedAt: '2030-01-01T00:00:00.000Z', id: 'Z' })
    const query = `?since=${ahead}`
    const body = await verified(await get(env, query), query)
    expect(body.datasets).toEqual([])
    expect(body.cursor).toBe(ahead)
  })
})
