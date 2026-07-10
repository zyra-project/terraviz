/**
 * Tests for the YouTube channel allowlist routes (task: media
 * suggestion engine): list (defaults + custom), add-by-URL with
 * server-side resolution, remove, and the privilege gate. The YouTube
 * API is stubbed via the resolver's injectable fetch (global fetch).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { onRequestGet as listGet, onRequestPost as addPost } from './youtube-channels'
import { onRequestDelete as removeDelete, onRequestPost as togglePost } from './youtube-channels/[id]'
import { asD1, seedFixtures } from '../../_lib/test-helpers'
import { addCustomChannel } from '../../_lib/youtube-channels-store'
import type { PublisherRow } from '../../_lib/publisher-store'

const ADMIN: PublisherRow = {
  id: 'PUB-ADMIN', email: 'a@e', display_name: 'Admin', affiliation: null, org_id: null,
  role: 'admin', is_admin: 1, status: 'active', created_at: '2026-01-01T00:00:00.000Z',
}
const PUBLISHER: PublisherRow = { ...ADMIN, id: 'PUB-PUB', email: 'p@e', role: 'publisher', is_admin: 0 }

const NASA = 'UCLA_DiR1FfKNvjuUpBHmylQ'
const CUSTOM = 'UCcustom0000000000000000' // UC + 22 chars

function setup() {
  const sqlite = seedFixtures({ count: 0 })
  sqlite
    .prepare(`INSERT INTO publishers (id, email, display_name, role, is_admin, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(ADMIN.id, ADMIN.email, ADMIN.display_name, ADMIN.role, ADMIN.is_admin, ADMIN.status, ADMIN.created_at)
  return { sqlite, env: { CATALOG_DB: asD1(sqlite), YOUTUBE_API_KEY: 'k' } }
}

function ctx(opts: { env: Record<string, unknown>; publisher?: PublisherRow; body?: unknown; id?: string }) {
  const url = `https://localhost/api/v1/publish/media/youtube-channels${opts.id ? `/${opts.id}` : ''}`
  const init: RequestInit = { method: opts.body !== undefined ? 'POST' : 'GET', headers: new Headers() }
  if (opts.body !== undefined) {
    ;(init.headers as Headers).set('Content-Type', 'application/json')
    init.body = JSON.stringify(opts.body)
  }
  return {
    request: new Request(url, init),
    env: opts.env,
    params: opts.id ? { id: opts.id } : {},
    data: { publisher: opts.publisher ?? ADMIN },
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: new URL(url).pathname,
  } as unknown as Parameters<typeof addPost>[0]
}

const readJson = async <T>(res: Response): Promise<T> => JSON.parse(await res.text()) as T

afterEach(() => vi.unstubAllGlobals())

describe('GET /publish/media/youtube-channels', () => {
  it('403 for a publisher-role account', async () => {
    const { env } = setup()
    expect((await listGet(ctx({ env, publisher: PUBLISHER }))).status).toBe(403)
  })

  it('lists built-in defaults plus the node custom channels', async () => {
    const { env } = setup()
    await addCustomChannel(env.CATALOG_DB, { channelId: CUSTOM, channelName: 'My Museum', addedBy: ADMIN.id })
    const res = await listGet(ctx({ env }))
    const { channels } = await readJson<{ channels: Array<{ channelId: string; builtin: boolean; disabled: boolean }> }>(res)
    expect(channels.some(c => c.channelId === NASA && c.builtin && !c.disabled)).toBe(true)
    expect(channels.some(c => c.channelId === CUSTOM && !c.builtin && !c.disabled)).toBe(true)
  })

  it('marks a switched-off built-in as disabled', async () => {
    const { env } = setup()
    await togglePost(ctx({ env, id: NASA, body: { disabled: true } }))
    const { channels } = await readJson<{ channels: Array<{ channelId: string; disabled: boolean }> }>(
      await listGet(ctx({ env })),
    )
    expect(channels.find(c => c.channelId === NASA)?.disabled).toBe(true)
  })

  it('degrades (not a 500) when the disabled/custom tables are missing (rollout / preview D1)', async () => {
    const { env, sqlite } = setup()
    // An un-migrated deploy: the new table (and even the custom one) absent.
    sqlite.prepare('DROP TABLE youtube_channels_disabled').run()
    sqlite.prepare('DROP TABLE youtube_channels').run()
    const res = await listGet(ctx({ env }))
    expect(res.status).toBe(200)
    const { channels } = await readJson<{ channels: Array<{ channelId: string; builtin: boolean; disabled: boolean }> }>(res)
    // Built-in defaults still list, none disabled; no custom channels.
    expect(channels.some(c => c.channelId === NASA && c.builtin && !c.disabled)).toBe(true)
    expect(channels.every(c => c.builtin)).toBe(true)
  })
})

describe('POST /publish/media/youtube-channels/:id (disable toggle)', () => {
  it('disables then re-enables a built-in, audit-logged', async () => {
    const { env, sqlite } = setup()
    const off = await togglePost(ctx({ env, id: NASA, body: { disabled: true } }))
    expect(off.status).toBe(200)
    expect(await readJson<{ disabled: boolean }>(off)).toEqual({ channelId: NASA, builtin: true, disabled: true })

    const disabledRow = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM youtube_channels_disabled WHERE channel_id = ?`)
      .get(NASA) as { n: number }
    expect(disabledRow.n).toBe(1)

    const on = await togglePost(ctx({ env, id: NASA, body: { disabled: false } }))
    expect(await readJson<{ disabled: boolean }>(on)).toEqual({ channelId: NASA, builtin: true, disabled: false })
    const afterEnable = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM youtube_channels_disabled WHERE channel_id = ?`)
      .get(NASA) as { n: number }
    expect(afterEnable.n).toBe(0)

    const actions = sqlite
      .prepare(`SELECT action FROM audit_events WHERE subject_id = ? ORDER BY created_at`)
      .all(NASA) as unknown as Array<{ action: string }>
    expect(actions.map(a => a.action)).toEqual(['youtube_channel.disable', 'youtube_channel.enable'])
  })

  it('404s a custom id (custom channels are removed, not disabled)', async () => {
    const { env } = setup()
    await addCustomChannel(env.CATALOG_DB, { channelId: CUSTOM, channelName: 'x', addedBy: ADMIN.id })
    expect((await togglePost(ctx({ env, id: CUSTOM, body: { disabled: true } }))).status).toBe(404)
  })

  it('400s a non-boolean disabled and 403s a publisher role', async () => {
    const { env } = setup()
    expect((await togglePost(ctx({ env, id: NASA, body: { disabled: 'yes' } }))).status).toBe(400)
    expect((await togglePost(ctx({ env, publisher: PUBLISHER, id: NASA, body: { disabled: true } }))).status).toBe(403)
  })
})

describe('POST /publish/media/youtube-channels', () => {
  it('adds a channel by direct-id URL, audit-logged', async () => {
    const { env, sqlite } = setup()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ items: [{ id: CUSTOM, snippet: { title: 'City Museum' } }] }),
    }) as unknown as Response))
    const res = await addPost(ctx({ env, body: { url: `https://youtube.com/channel/${CUSTOM}` } }))
    expect(res.status).toBe(201)
    const { channel } = await readJson<{ channel: { channelId: string; channelName: string } }>(res)
    expect(channel).toEqual({ channelId: CUSTOM, channelName: 'City Museum', builtin: false })
    const audit = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'youtube_channel.add' AND subject_id = ?`)
      .get(CUSTOM) as { n: number }
    expect(audit.n).toBe(1)
  })

  it('resolves a @handle via the API', async () => {
    const { env } = setup()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('forHandle=%40citymuseum')
      return { ok: true, json: async () => ({ items: [{ id: CUSTOM, snippet: { title: 'City Museum' } }] }) } as unknown as Response
    }))
    const res = await addPost(ctx({ env, body: { url: '@citymuseum' } }))
    expect(res.status).toBe(201)
  })

  it('400 for a missing or unrecognizable URL', async () => {
    const { env } = setup()
    expect((await addPost(ctx({ env, body: {} }))).status).toBe(400)
    const bad = await addPost(ctx({ env, body: { url: 'https://example.org/x' } }))
    expect(bad.status).toBe(400)
    expect((await readJson<{ errors: Array<{ code: string }> }>(bad)).errors[0].code).toBe('invalid_url')
  })

  it('surfaces unconfigured when a handle needs the key but none is set', async () => {
    const { env } = setup()
    const res = await addPost(ctx({ env: { ...env, YOUTUBE_API_KEY: undefined }, body: { url: '@citymuseum' } }))
    expect(res.status).toBe(400)
    expect((await readJson<{ errors: Array<{ code: string }> }>(res)).errors[0].code).toBe('unconfigured')
  })
})

describe('DELETE /publish/media/youtube-channels/:id', () => {
  it('removes a custom channel and 404s a built-in id', async () => {
    const { env } = setup()
    await addCustomChannel(env.CATALOG_DB, { channelId: CUSTOM, channelName: 'x', addedBy: ADMIN.id })
    expect((await removeDelete(ctx({ env, id: CUSTOM }))).status).toBe(200)
    expect((await removeDelete(ctx({ env, id: CUSTOM }))).status).toBe(404) // already gone
    expect((await removeDelete(ctx({ env, id: NASA }))).status).toBe(404) // built-in, not in the table
  })

  it('403 for a publisher-role account', async () => {
    const { env } = setup()
    expect((await removeDelete(ctx({ env, publisher: PUBLISHER, id: CUSTOM }))).status).toBe(403)
  })
})
