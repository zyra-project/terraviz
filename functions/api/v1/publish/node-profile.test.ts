/**
 * Wire-level tests for /api/v1/publish/node-profile — the singleton
 * host-organization profile (Phase 3d).
 *
 * Coverage: privileged gate on writes (403), GET before any write
 * (`profile: null`), PUT → GET round-trip, validation (missing
 * orgName, non-http link), links round-trip, corrupt stored
 * links_json degrading to `[]`, and the `node_profile.update` audit
 * row.
 */

import { describe, expect, it } from 'vitest'
import { onRequestGet, onRequestPut } from './node-profile'
import { asD1, seedFixtures } from '../_lib/test-helpers'
import { toPublicProfile, type NodeProfileRow } from '../_lib/node-profile-store'
import type { PublisherRow } from '../_lib/publisher-store'

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

function setupEnv() {
  const sqlite = seedFixtures({ count: 0 })
  sqlite
    .prepare(
      `INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ADMIN.id, ADMIN.email, ADMIN.display_name, ADMIN.role, ADMIN.is_admin, ADMIN.status, ADMIN.created_at)
  return { sqlite, env: { CATALOG_DB: asD1(sqlite) } }
}

function ctx(opts: { env: Record<string, unknown>; method: 'GET' | 'PUT'; publisher?: PublisherRow; body?: unknown }) {
  const url = 'https://localhost/api/v1/publish/node-profile'
  const init: RequestInit = { method: opts.method, headers: new Headers() }
  if (opts.body !== undefined) {
    ;(init.headers as Headers).set('Content-Type', 'application/json')
    init.body = JSON.stringify(opts.body)
  }
  return {
    request: new Request(url, init),
    env: opts.env,
    params: {},
    data: { publisher: opts.publisher ?? ADMIN },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: new URL(url).pathname,
  } as unknown as Parameters<typeof onRequestPut>[0]
}

async function readJson<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T
}

const VALID_BODY = {
  orgName: 'Coastal Science Center',
  mission: 'We connect visitors with live ocean data.',
  aboutMd: '## About us\nA museum on the gulf coast.',
  regionFocus: 'Gulf of Mexico coast',
  defaultTone: 'educational, general public',
  links: [{ label: 'Website', url: 'https://coastal.example.org' }],
}

describe('/api/v1/publish/node-profile', () => {
  it('GET returns profile: null before any write', async () => {
    const { env } = setupEnv()
    const res = await onRequestGet(ctx({ env, method: 'GET' }))
    expect(res.status).toBe(200)
    expect((await readJson<{ profile: unknown }>(res)).profile).toBeNull()
  })

  it('PUT is 403 for a publisher-role account', async () => {
    const { env } = setupEnv()
    const res = await onRequestPut(ctx({ env, method: 'PUT', publisher: PUBLISHER, body: VALID_BODY }))
    expect(res.status).toBe(403)
  })

  it('PUT → GET round-trips the profile and writes an audit row', async () => {
    const { env, sqlite } = setupEnv()
    const put = await onRequestPut(ctx({ env, method: 'PUT', body: VALID_BODY }))
    expect(put.status).toBe(200)

    const res = await onRequestGet(ctx({ env, method: 'GET' }))
    const { profile } = await readJson<{ profile: Record<string, unknown> }>(res)
    expect(profile.orgName).toBe('Coastal Science Center')
    expect(profile.mission).toBe('We connect visitors with live ocean data.')
    expect(profile.regionFocus).toBe('Gulf of Mexico coast')
    expect(profile.links).toEqual([{ label: 'Website', url: 'https://coastal.example.org' }])
    expect(profile.updatedBy).toBe(ADMIN.id)

    const audit = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'node_profile.update'`)
      .get() as { n: number }
    expect(audit.n).toBe(1)
  })

  it('PUT upserts — a second write replaces the first', async () => {
    const { env } = setupEnv()
    await onRequestPut(ctx({ env, method: 'PUT', body: VALID_BODY }))
    await onRequestPut(ctx({ env, method: 'PUT', body: { orgName: 'Renamed Center' } }))
    const res = await onRequestGet(ctx({ env, method: 'GET' }))
    const { profile } = await readJson<{ profile: Record<string, unknown> }>(res)
    expect(profile.orgName).toBe('Renamed Center')
    // Optional fields omitted in the second write are cleared, not kept.
    expect(profile.mission).toBeNull()
    expect(profile.links).toEqual([])
  })

  it('400 with field errors for a missing orgName and a non-http link', async () => {
    const { env } = setupEnv()
    const res = await onRequestPut(
      ctx({
        env,
        method: 'PUT',
        body: { links: [{ label: 'ftp', url: 'ftp://example.org' }] },
      }),
    )
    expect(res.status).toBe(400)
    const { errors } = await readJson<{ errors: Array<{ field: string; code: string }> }>(res)
    expect(errors.some(e => e.field === 'orgName' && e.code === 'required')).toBe(true)
    expect(errors.some(e => e.field === 'links[0]')).toBe(true)
  })

  it('400 invalid_json for a malformed body', async () => {
    const { env } = setupEnv()
    const bad = ctx({ env, method: 'PUT' })
    ;(bad as { request: Request }).request = new Request('https://localhost/api/v1/publish/node-profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    })
    const res = await onRequestPut(bad)
    expect(res.status).toBe(400)
    expect((await readJson<{ error: string }>(res)).error).toBe('invalid_json')
  })
})

describe('toPublicProfile', () => {
  const base: NodeProfileRow = {
    org_name: 'X',
    mission: null,
    about_md: null,
    region_focus: null,
    default_tone: null,
    links_json: null,
    logo_ref: null,
    updated_by: 'PUB-ADMIN',
    updated_at: '2026-07-01T00:00:00.000Z',
  }

  it('degrades corrupt links_json to an empty list', () => {
    expect(toPublicProfile({ ...base, links_json: '{oops' }).links).toEqual([])
    expect(toPublicProfile({ ...base, links_json: '[{"label":1}]' }).links).toEqual([])
  })

  it('re-validates stored links on read — non-http schemes dropped, list clamped', () => {
    // Legacy or hand-edited rows must not smuggle a javascript: url
    // past the http(s)-only contract, and an oversized list is clamped.
    const stored = [
      { label: 'ok', url: 'https://example.org' },
      { label: 'xss', url: 'javascript:alert(1)' }, // eslint-disable-line no-script-url
      { label: 'ftp', url: 'ftp://example.org' },
      { label: '', url: 'https://empty-label.example.org' },
      ...Array.from({ length: 15 }, (_, i) => ({ label: `l${i}`, url: `https://l${i}.example.org` })),
    ]
    const links = toPublicProfile({ ...base, links_json: JSON.stringify(stored) }).links
    expect(links[0]).toEqual({ label: 'ok', url: 'https://example.org' })
    expect(links.every(l => l.url.startsWith('http'))).toBe(true)
    expect(links).toHaveLength(10)
  })
})
