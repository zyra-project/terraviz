/**
 * Wire-level tests for the user-administration endpoints.
 *
 * Coverage:
 *   - GET list: admin-gated (403 for publisher / readonly / service),
 *     status/role/q filters, validation of ?status / ?limit.
 *   - GET {id}: admin-gated, 404 for unknown.
 *   - PATCH {id}: admin-gated, field validation, success envelope,
 *     and the self-lockout / last-admin guardrails surfaced as 409.
 */

import { describe, expect, it } from 'vitest'
import { onRequestGet as listGet } from './publishers'
import { onRequestGet as detailGet, onRequestPatch as detailPatch } from './publishers/[id]'
import { asD1, makeKV, seedFixtures } from '../_lib/test-helpers'
import type { PublisherRow } from '../_lib/publisher-store'
import type Database from 'better-sqlite3'

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
const SERVICE: PublisherRow = { ...ADMIN, id: 'PUB-SVC', email: 's@e', role: 'service', is_admin: 0 }

function seed(sqlite: Database.Database, p: PublisherRow): void {
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(p.id, p.email, p.display_name, p.role, p.is_admin, p.status, p.created_at)
}

function setupEnv(rows: PublisherRow[] = [ADMIN]) {
  const sqlite = seedFixtures({ count: 0 })
  for (const r of rows) seed(sqlite, r)
  return { sqlite, env: { CATALOG_DB: asD1(sqlite), CATALOG_KV: makeKV() } }
}

function ctx(opts: {
  env: Record<string, unknown>
  publisher?: PublisherRow
  method?: string
  body?: unknown
  bodyText?: string
  url?: string
  params?: Record<string, string>
}) {
  const url = opts.url ?? 'https://localhost/api/v1/publish/publishers'
  const headers = new Headers({ 'Content-Type': 'application/json' })
  const init: RequestInit = { method: opts.method ?? 'GET', headers }
  if (opts.bodyText !== undefined) init.body = opts.bodyText
  else if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
  return {
    request: new Request(url, init),
    env: opts.env,
    params: (opts.params ?? {}) as { [K in string]: string | string[] },
    data: { publisher: opts.publisher ?? ADMIN },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: new URL(url).pathname,
  } as unknown as Parameters<typeof detailPatch>[0]
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

describe('GET /api/v1/publish/publishers', () => {
  it('lists all publishers for an admin', async () => {
    const { env } = setupEnv([ADMIN, PUBLISHER, SERVICE])
    const res = await listGet(ctx({ env }))
    expect(res.status).toBe(200)
    const body = await readJson<{ publishers: PublisherRow[] }>(res)
    expect(body.publishers.map(p => p.id).sort()).toEqual(['PUB-ADMIN', 'PUB-PUB', 'PUB-SVC'])
  })

  it('filters by status', async () => {
    const pending = { ...PUBLISHER, id: 'PUB-PEND', email: 'pend@e', status: 'pending' }
    const { env } = setupEnv([ADMIN, pending])
    const res = await listGet(ctx({ env, url: 'https://localhost/api/v1/publish/publishers?status=pending' }))
    const body = await readJson<{ publishers: PublisherRow[] }>(res)
    expect(body.publishers.map(p => p.id)).toEqual(['PUB-PEND'])
  })

  it.each([
    ['PUB-PUB role', PUBLISHER],
    ['service token', SERVICE],
  ])('403s for a non-admin caller (%s)', async (_label, caller) => {
    const { env } = setupEnv([ADMIN, caller])
    const res = await listGet(ctx({ env, publisher: caller }))
    expect(res.status).toBe(403)
    expect((await readJson<{ error: string }>(res)).error).toBe('forbidden_role')
  })

  it('400s on an invalid status filter', async () => {
    const { env } = setupEnv()
    const res = await listGet(ctx({ env, url: 'https://localhost/api/v1/publish/publishers?status=bogus' }))
    expect(res.status).toBe(400)
    expect((await readJson<{ error: string }>(res)).error).toBe('invalid_status')
  })
})

describe('GET /api/v1/publish/publishers/{id}', () => {
  it('returns a single publisher for an admin', async () => {
    const { env } = setupEnv([ADMIN, PUBLISHER])
    const res = await detailGet(ctx({ env, params: { id: 'PUB-PUB' } }))
    expect(res.status).toBe(200)
    expect((await readJson<{ publisher: PublisherRow }>(res)).publisher.id).toBe('PUB-PUB')
  })

  it('404s for an unknown id', async () => {
    const { env } = setupEnv([ADMIN])
    const res = await detailGet(ctx({ env, params: { id: 'NOPE' } }))
    expect(res.status).toBe(404)
  })

  it('403s for a non-admin caller', async () => {
    const { env } = setupEnv([ADMIN, PUBLISHER])
    const res = await detailGet(ctx({ env, publisher: PUBLISHER, params: { id: 'PUB-ADMIN' } }))
    expect(res.status).toBe(403)
  })
})

describe('PATCH /api/v1/publish/publishers/{id}', () => {
  it('approves a pending publisher', async () => {
    const pending = { ...PUBLISHER, id: 'PUB-PEND', email: 'pend@e', status: 'pending' }
    const { env } = setupEnv([ADMIN, pending])
    const res = await detailPatch(ctx({ env, method: 'PATCH', params: { id: 'PUB-PEND' }, body: { status: 'active' } }))
    expect(res.status).toBe(200)
    expect((await readJson<{ publisher: PublisherRow }>(res)).publisher.status).toBe('active')
  })

  it('400s on an invalid role value', async () => {
    const { env } = setupEnv([ADMIN, PUBLISHER])
    const res = await detailPatch(ctx({ env, method: 'PATCH', params: { id: 'PUB-PUB' }, body: { role: 'wizard' } }))
    expect(res.status).toBe(400)
    const body = await readJson<{ errors: Array<{ field: string }> }>(res)
    expect(body.errors[0].field).toBe('role')
  })

  it('400s on status=pending (only active|suspended are PATCH-able)', async () => {
    const { env } = setupEnv([ADMIN, PUBLISHER])
    const res = await detailPatch(ctx({ env, method: 'PATCH', params: { id: 'PUB-PUB' }, body: { status: 'pending' } }))
    expect(res.status).toBe(400)
    const body = await readJson<{ errors: Array<{ field: string }> }>(res)
    expect(body.errors[0].field).toBe('status')
  })

  it('rejects service as an assignable role', async () => {
    const { env } = setupEnv([ADMIN, PUBLISHER])
    const res = await detailPatch(ctx({ env, method: 'PATCH', params: { id: 'PUB-PUB' }, body: { role: 'service' } }))
    expect(res.status).toBe(400)
  })

  it('403s for a non-admin caller', async () => {
    const { env } = setupEnv([ADMIN, PUBLISHER])
    const res = await detailPatch(
      ctx({ env, publisher: PUBLISHER, method: 'PATCH', params: { id: 'PUB-ADMIN' }, body: { status: 'suspended' } }),
    )
    expect(res.status).toBe(403)
  })

  it('409 self_lockout when the admin demotes themselves', async () => {
    const other = { ...ADMIN, id: 'PUB-OTHER', email: 'o@e' }
    const { env } = setupEnv([ADMIN, other])
    const res = await detailPatch(
      ctx({ env, method: 'PATCH', params: { id: 'PUB-ADMIN' }, body: { role: 'author' } }),
    )
    expect(res.status).toBe(409)
    expect((await readJson<{ error: string }>(res)).error).toBe('self_lockout')
  })

  it('409 last_admin when demoting the only active admin', async () => {
    const { env } = setupEnv([ADMIN])
    const ghost = { ...ADMIN, id: 'PUB-GHOST' }
    const res = await detailPatch(
      ctx({ env, publisher: ghost, method: 'PATCH', params: { id: 'PUB-ADMIN' }, body: { role: 'author' } }),
    )
    expect(res.status).toBe(409)
    expect((await readJson<{ error: string }>(res)).error).toBe('last_admin')
  })
})
