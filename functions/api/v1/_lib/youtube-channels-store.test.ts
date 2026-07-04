/**
 * Tests for the operator-configurable YouTube channels (task: media
 * suggestion engine): D1 CRUD, URL parsing, and pasted-URL → channel-id
 * resolution (the YouTube API is stubbed; the suite never hits it).
 */

import { describe, expect, it, vi } from 'vitest'
import {
  addCustomChannel,
  customChannelIds,
  isChannelId,
  listCustomChannels,
  parseChannelUrl,
  removeCustomChannel,
  resolveChannelUrl,
} from './youtube-channels-store'
import { asD1, seedFixtures } from './test-helpers'

const NASA = 'UCLA_DiR1FfKNvjuUpBHmylQ'

function db() {
  return asD1(seedFixtures({ count: 0 }))
}

describe('parseChannelUrl', () => {
  it('extracts a channel id from a /channel/UC… URL', () => {
    expect(parseChannelUrl(`https://youtube.com/channel/${NASA}`)).toEqual({ kind: 'id', value: NASA })
    expect(parseChannelUrl(`https://www.youtube-nocookie.com/channel/${NASA}`)).toEqual({ kind: 'id', value: NASA })
  })

  it('recognises a @handle (URL or bare) and legacy /c and /user forms', () => {
    expect(parseChannelUrl('https://www.youtube.com/@NASA')).toEqual({ kind: 'handle', value: '@NASA' })
    expect(parseChannelUrl('@NOAA')).toEqual({ kind: 'handle', value: '@NOAA' })
    expect(parseChannelUrl('https://youtube.com/c/NOAAvisualizations')).toEqual({ kind: 'user', value: 'NOAAvisualizations' })
    expect(parseChannelUrl('https://youtube.com/user/USGS')).toEqual({ kind: 'user', value: 'USGS' })
  })

  it('rejects non-YouTube hosts and unusable paths', () => {
    expect(parseChannelUrl('https://vimeo.com/channel/x')).toBeNull()
    expect(parseChannelUrl('https://youtube.com/watch?v=x')).toBeNull()
    expect(parseChannelUrl('https://youtube.com/channel/not-an-id')).toBeNull()
    expect(parseChannelUrl('not a url')).toBeNull()
  })
})

describe('isChannelId', () => {
  it('matches the canonical UC… shape only', () => {
    expect(isChannelId(NASA)).toBe(true)
    expect(isChannelId('UCtoo-short')).toBe(false)
    expect(isChannelId('@NASA')).toBe(false)
  })
})

describe('resolveChannelUrl', () => {
  it('resolves a direct-id URL without an API call (title fetched when possible)', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ items: [{ id: NASA, snippet: { title: 'NASA' } }] }),
    }) as unknown as Response)
    const r = await resolveChannelUrl(`https://youtube.com/channel/${NASA}`, 'key', fetchFn as unknown as typeof fetch)
    expect(r).toEqual({ ok: true, channelId: NASA, channelName: 'NASA' })
  })

  it('resolves a @handle via the channels.list API', async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain('forHandle=%40NASA')
      return { ok: true, json: async () => ({ items: [{ id: NASA, snippet: { title: 'NASA' } }] }) } as unknown as Response
    })
    const r = await resolveChannelUrl('@NASA', 'key', fetchFn as unknown as typeof fetch)
    expect(r).toEqual({ ok: true, channelId: NASA, channelName: 'NASA' })
  })

  it('needs the key to resolve a handle but not a direct id', async () => {
    const idle = vi.fn()
    expect(await resolveChannelUrl('@NASA', undefined, idle as unknown as typeof fetch)).toEqual({
      ok: false,
      code: 'unconfigured',
    })
    // A direct-id URL still works with no key (no lookup needed).
    expect(await resolveChannelUrl(`https://youtube.com/channel/${NASA}`, undefined, idle as unknown as typeof fetch)).toEqual({
      ok: true,
      channelId: NASA,
      channelName: NASA,
    })
    expect(idle).not.toHaveBeenCalled()
  })

  it('reports invalid_url and unresolved', async () => {
    expect(await resolveChannelUrl('nope', 'key', vi.fn() as unknown as typeof fetch)).toEqual({
      ok: false,
      code: 'invalid_url',
    })
    const empty = vi.fn(async () => ({ ok: true, json: async () => ({ items: [] }) }) as unknown as Response)
    expect(await resolveChannelUrl('@ghost', 'key', empty as unknown as typeof fetch)).toEqual({
      ok: false,
      code: 'unresolved',
    })
  })
})

describe('custom-channel CRUD', () => {
  it('adds, lists, exposes the id set, and removes', async () => {
    const d = db()
    await addCustomChannel(d, { channelId: NASA, channelName: 'NASA', addedBy: null }, '2026-07-01T00:00:00.000Z')
    const list = await listCustomChannels(d)
    expect(list).toEqual([{ channelId: NASA, channelName: 'NASA', createdAt: '2026-07-01T00:00:00.000Z' }])
    expect([...(await customChannelIds(d))]).toEqual([NASA])

    // Re-add refreshes the name, not a duplicate.
    await addCustomChannel(d, { channelId: NASA, channelName: 'NASA TV', addedBy: null })
    expect((await listCustomChannels(d))).toHaveLength(1)
    expect((await listCustomChannels(d))[0].channelName).toBe('NASA TV')

    expect(await removeCustomChannel(d, NASA)).toBe(true)
    expect(await removeCustomChannel(d, NASA)).toBe(false) // gone
    expect(await listCustomChannels(d)).toEqual([])
  })
})
