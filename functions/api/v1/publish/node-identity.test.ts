import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { onRequestGet, onRequestPut } from './node-identity'
import { asD1, makeKV } from '../_lib/test-helpers'
import type { PublisherRow } from '../_lib/publisher-store'

// A real ed25519 wire key: 32 raw bytes, standard base64. The route
// validates the prefix + that the body decodes to exactly 32 bytes,
// so test fixtures must use a well-formed value.
const VALID_KEY = 'ed25519:' + Buffer.alloc(32, 7).toString('base64')

function freshDb() {
  const db = new Database(':memory:')
  // Mirror migrations 0001 + 0016 (the singleton guard).
  db.exec(`
    CREATE TABLE node_identity (
      node_id       TEXT PRIMARY KEY,
      display_name  TEXT NOT NULL,
      base_url      TEXT NOT NULL,
      description   TEXT,
      contact_email TEXT,
      public_key    TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      singleton     INTEGER NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX idx_node_identity_singleton ON node_identity(singleton);
  `)
  return db
}

const ADMIN: PublisherRow = {
  id: 'PUB_ADMIN',
  email: 'admin@example.com',
  display_name: 'Admin',
  affiliation: null,
  org_id: null,
  role: 'staff',
  is_admin: 1,
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
}

const SERVICE: PublisherRow = { ...ADMIN, id: 'PUB_SVC', role: 'service', is_admin: 0 }
const COMMUNITY: PublisherRow = { ...ADMIN, id: 'PUB_C', role: 'community', is_admin: 0 }

function putCtx(db: Database.Database, publisher: PublisherRow, body: unknown, kv = makeKV()) {
  return {
    request: new Request('https://node.example.org/api/v1/publish/node-identity', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env: { CATALOG_DB: asD1(db), CATALOG_KV: kv },
    params: {},
    data: { publisher },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: '/api/v1/publish/node-identity',
  } as unknown as Parameters<PagesFunction>[0]
}

async function bodyOf(res: Response): Promise<any> {
  return JSON.parse(await res.text())
}

describe('PUT /api/v1/publish/node-identity', () => {
  it('provisions a fresh identity for an admin and busts the snapshot', async () => {
    const db = freshDb()
    const kv = makeKV()
    const res = await onRequestPut(
      putCtx(db, ADMIN, {
        display_name: 'Terraviz — Acme',
        base_url: 'https://terraviz.acme.org',
        contact_email: 'ops@acme.org',
        public_key: VALID_KEY,
      }, kv),
    )
    expect(res.status).toBe(200)
    const { identity } = await bodyOf(res)
    expect(identity.display_name).toBe('Terraviz — Acme')
    expect(identity.base_url).toBe('https://terraviz.acme.org')
    expect(identity.public_key).toBe(VALID_KEY)
    expect(identity.node_id).toBeTruthy()
    // Row actually written.
    const row = db.prepare('SELECT * FROM node_identity').get() as any
    expect(row.contact_email).toBe('ops@acme.org')
    // Snapshot invalidated.
    expect(kv.delete).toHaveBeenCalled()
  })

  it('rejects a fresh provision without a public key', async () => {
    const db = freshDb()
    const res = await onRequestPut(
      putCtx(db, ADMIN, {
        display_name: 'No Key',
        base_url: 'https://no-key.example.org',
      }),
    )
    expect(res.status).toBe(400)
    const body = await bodyOf(res)
    expect(body.error).toBe('validation_failed')
    expect(body.errors.some((e: any) => e.field === 'public_key' && e.code === 'required')).toBe(true)
  })

  it('updates an existing row, preserving node_id and keeping the key when omitted', async () => {
    const db = freshDb()
    db.prepare(
      `INSERT INTO node_identity (node_id, display_name, base_url, description, contact_email, public_key, created_at)
       VALUES ('NODE1', 'Old', 'https://old.example.org', NULL, NULL, 'ed25519:original', '2026-01-01T00:00:00.000Z')`,
    ).run()
    const res = await onRequestPut(
      putCtx(db, ADMIN, {
        display_name: 'New Name',
        base_url: 'https://new.example.org',
      }),
    )
    expect(res.status).toBe(200)
    const { identity } = await bodyOf(res)
    expect(identity.node_id).toBe('NODE1')
    expect(identity.display_name).toBe('New Name')
    expect(identity.public_key).toBe('ed25519:original') // unchanged
    expect(identity.created_at).toBe('2026-01-01T00:00:00.000Z') // preserved
    // Exactly one row (update, not insert).
    expect((db.prepare('SELECT count(*) c FROM node_identity').get() as any).c).toBe(1)
  })

  it('rejects an invalid base_url', async () => {
    const db = freshDb()
    const res = await onRequestPut(
      putCtx(db, ADMIN, { display_name: 'X', base_url: 'ftp://nope', public_key: VALID_KEY }),
    )
    expect(res.status).toBe(400)
    const body = await bodyOf(res)
    expect(body.errors.some((e: any) => e.field === 'base_url')).toBe(true)
  })

  it('caps base_url length like the other string fields', async () => {
    const db = freshDb()
    const huge = 'https://x.example.org/' + 'a'.repeat(3000)
    const res = await onRequestPut(
      putCtx(db, ADMIN, { display_name: 'X', base_url: huge, public_key: VALID_KEY }),
    )
    expect(res.status).toBe(400)
    const body = await bodyOf(res)
    expect(body.errors.some((e: any) => e.field === 'base_url' && e.code === 'too_long')).toBe(true)
    expect((db.prepare('SELECT count(*) c FROM node_identity').get() as any).c).toBe(0)
  })

  it('rejects a malformed public_key (wrong prefix / not 32 bytes)', async () => {
    const db = freshDb()
    for (const bad of ['abc123', 'ed25519:abc123', 'ed25519:' + Buffer.alloc(16).toString('base64')]) {
      const res = await onRequestPut(
        putCtx(db, ADMIN, {
          display_name: 'Bad Key',
          base_url: 'https://bad-key.example.org',
          public_key: bad,
        }),
      )
      expect(res.status).toBe(400)
      const body = await bodyOf(res)
      expect(body.errors.some((e: any) => e.field === 'public_key' && e.code === 'format')).toBe(true)
    }
    // Nothing was written.
    expect((db.prepare('SELECT count(*) c FROM node_identity').get() as any).c).toBe(0)
  })

  it('allows a service token (bootstrap credential)', async () => {
    const db = freshDb()
    const res = await onRequestPut(
      putCtx(db, SERVICE, {
        display_name: 'Svc Provisioned',
        base_url: 'https://svc.example.org',
        public_key: VALID_KEY,
      }),
    )
    expect(res.status).toBe(200)
  })

  it('stays a single row across repeated first-time provisions', async () => {
    const db = freshDb()
    for (let i = 0; i < 3; i++) {
      const res = await onRequestPut(
        putCtx(db, ADMIN, {
          display_name: `Provision ${i}`,
          base_url: 'https://once.example.org',
          public_key: VALID_KEY,
        }),
      )
      expect(res.status).toBe(200)
    }
    expect((db.prepare('SELECT count(*) c FROM node_identity').get() as any).c).toBe(1)
  })

  it('forbids a non-admin, non-service publisher', async () => {
    const db = freshDb()
    const res = await onRequestPut(
      putCtx(db, COMMUNITY, {
        display_name: 'Nope',
        base_url: 'https://nope.example.org',
        public_key: 'ed25519:k',
      }),
    )
    expect(res.status).toBe(403)
    expect((await bodyOf(res)).error).toBe('forbidden')
    expect(db.prepare('SELECT count(*) c FROM node_identity').get()).toMatchObject({ c: 0 })
  })

  it('rejects a non-JSON body', async () => {
    const db = freshDb()
    const ctx = {
      request: new Request('https://node.example.org/api/v1/publish/node-identity', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      }),
      env: { CATALOG_DB: asD1(db), CATALOG_KV: makeKV() },
      params: {},
      data: { publisher: ADMIN },
      waitUntil: () => {},
      passThroughOnException: () => {},
      next: async () => new Response(null),
      functionPath: '/api/v1/publish/node-identity',
    } as unknown as Parameters<PagesFunction>[0]
    const res = await onRequestPut(ctx)
    expect(res.status).toBe(400)
    expect((await bodyOf(res)).error).toBe('invalid_json')
  })
})

describe('GET /api/v1/publish/node-identity', () => {
  it('returns null on a fresh deploy and the row once provisioned', async () => {
    const db = freshDb()
    const ctxOpts = () =>
      ({
        request: new Request('https://node.example.org/api/v1/publish/node-identity'),
        env: { CATALOG_DB: asD1(db) },
        params: {},
        data: { publisher: ADMIN },
        waitUntil: () => {},
        passThroughOnException: () => {},
        next: async () => new Response(null),
        functionPath: '/api/v1/publish/node-identity',
      }) as unknown as Parameters<PagesFunction>[0]

    let res = await onRequestGet(ctxOpts())
    expect(res.status).toBe(200)
    expect((await bodyOf(res)).identity).toBeNull()

    db.prepare(
      `INSERT INTO node_identity (node_id, display_name, base_url, description, contact_email, public_key, created_at)
       VALUES ('N', 'D', 'https://d.example.org', NULL, NULL, 'ed25519:k', '2026-01-01T00:00:00.000Z')`,
    ).run()
    res = await onRequestGet(ctxOpts())
    expect((await bodyOf(res)).identity.node_id).toBe('N')
  })
})
