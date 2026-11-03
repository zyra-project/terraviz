// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Wire-level tests for /api/v1/publish/node-profile — the singleton
 * host-organization profile (Phase 3d).
 *
 * Coverage: privileged gate on writes (403), GET before any write
 * (`profile: null`), PUT → GET round-trip, validation (missing
 * orgName, non-http link, a bad splash tagline), links round-trip,
 * corrupt stored links_json degrading to `[]`, the public cache bust,
 * and the `node_profile.update` audit row.
 */

import { describe, expect, it } from 'vitest'
import { onRequestGet, onRequestPut } from './node-profile'
import { asD1, makeKV, seedFixtures } from '../_lib/test-helpers'
import {
  NODE_PROFILE_CACHE_KEY,
  PROFILE_TAGLINE_MAX_LEN,
  getNodeProfile,
  toPublicProfile,
  type NodeProfileRow,
} from '../_lib/node-profile-store'
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
  tagline: 'Gulf Coast Science',
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
    expect(profile.tagline).toBe('Gulf Coast Science')
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
    // ...except the tagline, added after them: a writer that predates
    // it omits it without meaning to clear it.
    expect(profile.tagline).toBe('Gulf Coast Science')
  })

  it('clears the tagline on an explicit null or empty string', async () => {
    for (const cleared of [null, '']) {
      const { env } = setupEnv()
      await onRequestPut(ctx({ env, method: 'PUT', body: VALID_BODY }))
      await onRequestPut(ctx({ env, method: 'PUT', body: { ...VALID_BODY, tagline: cleared } }))
      const { profile } = await readJson<{ profile: Record<string, unknown> }>(
        await onRequestGet(ctx({ env, method: 'GET' })),
      )
      expect(profile.tagline).toBeNull()
    }
  })

  it('PUT busts the public profile cache, so a new tagline reaches the splash', async () => {
    const { env } = setupEnv()
    const kv = makeKV()
    await kv.put(NODE_PROFILE_CACHE_KEY, '{"profile":null}')
    const res = await onRequestPut(ctx({ env: { ...env, CATALOG_KV: kv }, method: 'PUT', body: VALID_BODY }))
    expect(res.status).toBe(200)
    expect(await kv.get(NODE_PROFILE_CACHE_KEY)).toBeNull()
  })

  it('trims the tagline and stores an empty one as none', async () => {
    const { env } = setupEnv()
    await onRequestPut(ctx({ env, method: 'PUT', body: { orgName: 'X', tagline: '  Global Systems Laboratory  ' } }))
    let profile = (await readJson<{ profile: Record<string, unknown> }>(await onRequestGet(ctx({ env, method: 'GET' })))).profile
    expect(profile.tagline).toBe('Global Systems Laboratory')

    await onRequestPut(ctx({ env, method: 'PUT', body: { orgName: 'X', tagline: '   ' } }))
    profile = (await readJson<{ profile: Record<string, unknown> }>(await onRequestGet(ctx({ env, method: 'GET' })))).profile
    expect(profile.tagline).toBeNull()
  })

  it('400 for a tagline that is too long, not text, not one line, or carries invisible characters', async () => {
    const { env } = setupEnv()
    for (const tagline of [
      'x'.repeat(PROFILE_TAGLINE_MAX_LEN + 1),
      42,
      'Two\nlines',
      'Tab\there',
      'Right\u202Eto left',
      'Zero\u200Bwidth',
    ]) {
      const res = await onRequestPut(ctx({ env, method: 'PUT', body: { orgName: 'X', tagline } }))
      expect(res.status).toBe(400)
      const { errors } = await readJson<{ errors: Array<{ field: string }> }>(res)
      expect(errors.map(e => e.field)).toEqual(['tagline'])
    }
    const ok = await onRequestPut(
      ctx({ env, method: 'PUT', body: { orgName: 'X', tagline: 'x'.repeat(PROFILE_TAGLINE_MAX_LEN) } }),
    )
    expect(ok.status).toBe(200)
  })

  it('audits the tagline set and the one it replaced', async () => {
    const { env, sqlite } = setupEnv()
    await onRequestPut(ctx({ env, method: 'PUT', body: VALID_BODY }))
    await onRequestPut(ctx({ env, method: 'PUT', body: { ...VALID_BODY, tagline: 'Global Systems Laboratory' } }))
    const rows = sqlite
      .prepare(`SELECT metadata_json FROM audit_events WHERE action = 'node_profile.update' ORDER BY rowid`)
      .all() as Array<{ metadata_json: string }>
    const last = JSON.parse(rows[rows.length - 1].metadata_json) as Record<string, unknown>
    expect(last.tagline).toBe('Global Systems Laboratory')
    expect(last.previous_tagline).toBe('Gulf Coast Science')
  })

  it('on a database without migration 0060: saves without a tagline, refuses one with 409', async () => {
    // (The read side of the same database is in node-profile.test.ts.)
    const { env, sqlite } = setupEnv()
    sqlite.prepare('ALTER TABLE node_profile DROP COLUMN tagline').run()

    const refused = await onRequestPut(ctx({ env, method: 'PUT', body: VALID_BODY }))
    expect(refused.status).toBe(409)
    const { errors } = await readJson<{ errors: Array<{ field: string; code: string }> }>(refused)
    expect(errors).toEqual([expect.objectContaining({ field: 'tagline', code: 'migration_missing' })])
    // Refused whole: nothing written.
    const none = await onRequestGet(ctx({ env, method: 'GET' }))
    expect((await readJson<{ profile: unknown }>(none)).profile).toBeNull()

    for (const body of [{ ...VALID_BODY, tagline: null }, { orgName: 'Coastal Science Center' }]) {
      const saved = await onRequestPut(ctx({ env, method: 'PUT', body }))
      expect(saved.status).toBe(200)
    }
    const { profile } = await readJson<{ profile: Record<string, unknown> }>(
      await onRequestGet(ctx({ env, method: 'GET' })),
    )
    expect(profile.orgName).toBe('Coastal Science Center')
    expect(profile.tagline).toBeNull()
  })

  it('does not mistake a one-off database error for a missing column', async () => {
    const { env } = setupEnv()
    await onRequestPut(ctx({ env, method: 'PUT', body: VALID_BODY }))
    const db = env.CATALOG_DB as D1Database
    let failNext = true
    const flaky = {
      prepare(sql: string) {
        if (failNext && sql.includes('tagline')) {
          failNext = false
          throw new Error('D1_ERROR: Network connection lost.')
        }
        return db.prepare(sql)
      },
    } as unknown as D1Database
    await expect(getNodeProfile(flaky)).rejects.toThrow('Network connection lost')
    // The retry reads the real tagline, not a fallback null.
    expect((await getNodeProfile(flaky))?.tagline).toBe('Gulf Coast Science')
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
    tagline: null,
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

  it('re-validates a stored tagline on read — a hand-edited bad one reads as none', () => {
    expect(toPublicProfile({ ...base, tagline: 'Global Systems Laboratory' }).tagline).toBe('Global Systems Laboratory')
    expect(toPublicProfile({ ...base, tagline: 'Two\nlines' }).tagline).toBeNull()
    expect(toPublicProfile({ ...base, tagline: 'x'.repeat(PROFILE_TAGLINE_MAX_LEN + 1) }).tagline).toBeNull()
    expect(toPublicProfile({ ...base, tagline: '   ' }).tagline).toBeNull()
  })
})
