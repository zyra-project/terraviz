// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the /publish/feeds console — privileged gate, connector
 * rows (state + bookkeeping), preset gallery add/added states,
 * pause/resume + remove wiring, the custom-feed form, and Run now.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderFeedsPage } from './feeds'
import { fetchFeatures, resetFeaturesCache } from '../features'
import { FEED_PRESETS } from '../feed-presets'
import { until } from '../../../test-utils'

interface RouteSpec { status?: number; body?: unknown }

function mockFetch(routes: Record<string, RouteSpec>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const method = init?.method ?? 'GET'
    const bare = String(path).split('?')[0]
    const spec = routes[`${method} ${bare}`] ?? routes[bare] ?? {}
    const status = spec.status ?? 200
    const body = spec.body ?? {}
    return {
      ok: status >= 200 && status < 300,
      status,
      type: 'basic',
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response
  })
}

const EONET_FEED = {
  id: 'FEED_EONET_DEFAULT',
  kind: 'eonet',
  label: 'NASA EONET',
  url: 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=14',
  category: 'hazards',
  enabled: true,
  lastRunAt: '2026-07-02T10:00:00.000Z',
  lastRunStatus: 'ok',
  lastRunError: null,
}

const NASA_CHANNEL = 'UCLA_DiR1FfKNvjuUpBHmylQ'
const CUSTOM_CHANNEL = 'UCcustom0000000000000000'

const baseRoutes = (): Record<string, RouteSpec> => ({
  '/api/v1/publish/me': { body: { role: 'admin', is_admin: true } },
  '/api/v1/publish/feeds': { body: { feeds: [EONET_FEED] } },
  '/api/v1/publish/media/youtube-channels': {
    body: {
      channels: [
        { channelId: NASA_CHANNEL, channelName: 'NASA', builtin: true },
        { channelId: CUSTOM_CHANNEL, channelName: 'City Museum', builtin: false },
      ],
    },
  },
  '/api/v1/publish/media/video-sources': { body: { sources: [] } },
})

const flush = () => new Promise<void>(r => setTimeout(r, 0))

let mount: HTMLElement
beforeEach(() => {
  mount = document.createElement('div')
  document.body.replaceChildren(mount)
})

describe('renderFeedsPage', () => {
  it('renders the disabled card (and skips every fetch) when events is off', async () => {
    // Prime the module-cached toggle map with events off, then render
    // — the page consults the cache before touching its own APIs.
    resetFeaturesCache()
    try {
      await fetchFeatures({
        fetchFn: mockFetch({
          '/api/v1/publish/node-settings': { body: { features: { events: false } } },
        }) as unknown as typeof fetch,
      })
      const pageFetch = mockFetch(baseRoutes())
      await renderFeedsPage(mount, { fetchFn: pageFetch })
      expect(mount.querySelector('.publisher-feature-disabled')).not.toBeNull()
      expect(mount.querySelector('.publisher-feeds-row')).toBeNull()
      expect(pageFetch).not.toHaveBeenCalled()
    } finally {
      resetFeaturesCache()
    }
  })

  it('shows a restricted card for a non-privileged publisher', async () => {
    const routes = baseRoutes()
    routes['/api/v1/publish/me'] = { body: { role: 'publisher', is_admin: false } }
    // The feeds list legitimately 403s for this caller — the role gate
    // must win over the generic error card.
    routes['/api/v1/publish/feeds'] = { status: 403, body: { error: 'forbidden_role' } }
    await renderFeedsPage(mount, { fetchFn: mockFetch(routes) })
    expect(mount.querySelector('.publisher-feeds-restricted')).not.toBeNull()
    expect(mount.querySelector('.publisher-feeds-row')).toBeNull()
  })

  it('renders connector rows with enabled dot + last-run bookkeeping', async () => {
    await renderFeedsPage(mount, { fetchFn: mockFetch(baseRoutes()) })
    const row = mount.querySelector('.publisher-feeds-row')!
    expect(row.querySelector('.publisher-feeds-row-label')?.textContent).toBe('NASA EONET')
    expect(row.querySelector('.publisher-feeds-dot-on')).not.toBeNull()
    expect(row.querySelector('.publisher-feeds-row-meta')?.textContent).toContain('2026-07-02 10:00')
  })

  it('surfaces a failed last run on the row', async () => {
    const routes = baseRoutes()
    routes['/api/v1/publish/feeds'] = {
      body: {
        feeds: [{ ...EONET_FEED, enabled: false, lastRunStatus: 'error', lastRunError: 'feed responded 502' }],
      },
    }
    await renderFeedsPage(mount, { fetchFn: mockFetch(routes) })
    expect(mount.querySelector('.publisher-feeds-dot-off')).not.toBeNull()
    const meta = mount.querySelector('.publisher-feeds-row-meta-error')
    expect(meta?.textContent).toContain('feed responded 502')
  })

  it('renders the preset gallery with an already-added preset disabled', async () => {
    await renderFeedsPage(mount, { fetchFn: mockFetch(baseRoutes()) })
    const presets = mount.querySelectorAll('.publisher-feeds-preset')
    expect(presets).toHaveLength(FEED_PRESETS.length)
    // EONET (same URL as the registered row) shows as added; others
    // don't. Skip each row's Preview toggle (marked aria-expanded).
    const buttons = [...presets].map(p => p.querySelector<HTMLButtonElement>('button:not([aria-expanded])')!)
    const disabled = buttons.filter(b => b.disabled)
    expect(disabled).toHaveLength(1)
  })

  it('adding a preset POSTs the connector-create body', async () => {
    const routes = baseRoutes()
    routes['POST /api/v1/publish/feeds'] = { status: 201, body: { feed: {} } }
    const fetchFn = mockFetch(routes)
    await renderFeedsPage(mount, { fetchFn })
    const enabledBtn = [...mount.querySelectorAll('.publisher-feeds-preset button:not([aria-expanded])')].find(
      b => !(b as HTMLButtonElement).disabled,
    ) as HTMLButtonElement
    enabledBtn.click()
    await flush()
    const post = fetchFn.mock.calls.find(c => (c[1]?.method ?? 'GET') === 'POST')
    expect(post).toBeTruthy()
    const body = JSON.parse(String(post![1]!.body)) as { kind: string; url: string; label: string }
    expect(body.kind).toBeTruthy()
    expect(body.url).toMatch(/^https:\/\//)
  })

  it('pause posts enabled:false to the connector', async () => {
    const routes = baseRoutes()
    routes['POST /api/v1/publish/feeds/FEED_EONET_DEFAULT'] = { body: { feed: {} } }
    const fetchFn = mockFetch(routes)
    await renderFeedsPage(mount, { fetchFn })
    const pauseBtn = [...mount.querySelectorAll('.publisher-feeds-row-actions button')].find(
      b => b.textContent === 'Pause',
    ) as HTMLButtonElement
    pauseBtn.click()
    await flush()
    const post = fetchFn.mock.calls.find(c => String(c[0]).includes('/feeds/FEED_EONET_DEFAULT'))
    expect(post).toBeTruthy()
    expect(JSON.parse(String(post![1]!.body))).toEqual({ enabled: false })
  })

  it('the custom form validates then POSTs a bring-your-own rss connector', async () => {
    const routes = baseRoutes()
    routes['POST /api/v1/publish/feeds'] = { status: 201, body: { feed: {} } }
    const fetchFn = mockFetch(routes)
    await renderFeedsPage(mount, { fetchFn })

    const addBtn = [...mount.querySelectorAll('button')].find(
      b => b.textContent === 'Add feed',
    ) as HTMLButtonElement
    // Invalid first: no URL → client-side error, no POST.
    ;(mount.querySelector('#feeds-custom-label') as HTMLInputElement).value = 'My Feed'
    addBtn.click()
    await flush()
    expect(mount.querySelector('.publisher-feeds-status-error')).not.toBeNull()
    expect(fetchFn.mock.calls.some(c => (c[1]?.method ?? 'GET') === 'POST')).toBe(false)

    ;(mount.querySelector('#feeds-custom-url') as HTMLInputElement).value = 'https://my.example/feed.xml'
    addBtn.click()
    await flush()
    const post = fetchFn.mock.calls.find(c => (c[1]?.method ?? 'GET') === 'POST')
    expect(post).toBeTruthy()
    expect(JSON.parse(String(post![1]!.body))).toMatchObject({
      kind: 'rss',
      label: 'My Feed',
      url: 'https://my.example/feed.xml',
    })
  })

  it("surfaces the server's own error message on a failed mutation", async () => {
    const routes = baseRoutes()
    routes['POST /api/v1/publish/feeds/FEED_EONET_DEFAULT'] = {
      status: 502,
      body: { error: 'feed_unavailable', message: 'The feed responded 502.' },
    }
    await renderFeedsPage(mount, { fetchFn: mockFetch(routes) })
    const pauseBtn = [...mount.querySelectorAll('.publisher-feeds-row-actions button')].find(
      b => b.textContent === 'Pause',
    ) as HTMLButtonElement
    pauseBtn.click()
    await flush()
    expect(mount.querySelector('.publisher-feeds-status')?.textContent).toBe('The feed responded 502.')
  })

  it('preview toggles an inline latest-items panel on a feed row', async () => {
    const routes = baseRoutes()
    routes['/api/v1/publish/feeds/preview'] = {
      body: {
        fetched: 2,
        mappable: 2,
        items: [
          { title: 'Story A', publishedAt: '2026-07-01T10:00:00.000Z', url: 'https://example.org/a' },
          { title: 'Story B', publishedAt: null, url: 'https://example.org/b' },
        ],
      },
    }
    const fetchFn = mockFetch(routes)
    await renderFeedsPage(mount, { fetchFn })

    const previewBtn = [...mount.querySelectorAll('.publisher-feeds-row-actions button')].find(
      b => b.textContent === 'Preview',
    ) as HTMLButtonElement
    previewBtn.click()
    await flush()

    // The dry-run call carries the connector's kind + url.
    const call = fetchFn.mock.calls.find(c => String(c[0]).includes('/feeds/preview'))
    expect(call).toBeTruthy()
    expect(String(call![0])).toContain('kind=eonet')
    expect(String(call![0])).toContain(encodeURIComponent(EONET_FEED.url))

    const panel = mount.querySelector('.publisher-feeds-preview') as HTMLElement
    expect(panel.hidden).toBe(false)
    const titles = [...panel.querySelectorAll('.publisher-feeds-preview-title')].map(a => a.textContent)
    expect(titles).toEqual(['Story A', 'Story B'])
    expect(panel.querySelector('.publisher-feeds-preview-date')?.textContent).toBe('2026-07-01')
    expect(previewBtn.getAttribute('aria-expanded')).toBe('true')

    // Second click collapses.
    previewBtn.click()
    expect(panel.hidden).toBe(true)
    expect(previewBtn.getAttribute('aria-expanded')).toBe('false')
  })

  it('Run now hits the refresh endpoint and reports the summary', async () => {
    const routes = baseRoutes()
    routes['POST /api/v1/publish/events/refresh'] = { body: { created: 3, refreshed: 1, failed: 0 } }
    const fetchFn = mockFetch(routes)
    await renderFeedsPage(mount, { fetchFn })
    const runBtn = [...mount.querySelectorAll('button')].find(b =>
      b.textContent?.includes('Run all enabled feeds'),
    ) as HTMLButtonElement
    runBtn.click()
    await flush()
    expect(fetchFn.mock.calls.some(c => String(c[0]).includes('/events/refresh'))).toBe(true)
  })

  it('lists built-in + custom YouTube channels; built-ins toggle, custom ones remove', async () => {
    await renderFeedsPage(mount, { fetchFn: mockFetch(baseRoutes()) })
    const rows = [...mount.querySelectorAll('.publisher-feeds-channel-row')]
    expect(rows.length).toBe(2)
    const builtinRow = rows.find(r => r.textContent?.includes('NASA'))!
    const customRow = rows.find(r => r.textContent?.includes('City Museum'))!
    // Built-in can't be removed — it has a Disable toggle; custom has Remove.
    expect(builtinRow.querySelector('button')?.textContent).toBe('Disable')
    expect(customRow.querySelector('button')?.textContent).toBe('Remove')
  })

  it('shows Enable on a disabled built-in and re-enables it via POST { disabled: false }', async () => {
    const routes = baseRoutes()
    routes['/api/v1/publish/media/youtube-channels'] = {
      body: {
        channels: [
          { channelId: NASA_CHANNEL, channelName: 'NASA', builtin: true, disabled: true },
          { channelId: CUSTOM_CHANNEL, channelName: 'City Museum', builtin: false, disabled: false },
        ],
      },
    }
    routes[`POST /api/v1/publish/media/youtube-channels/${NASA_CHANNEL}`] = {
      body: { channelId: NASA_CHANNEL, builtin: true, disabled: false },
    }
    const fetchFn = mockFetch(routes)
    await renderFeedsPage(mount, { fetchFn })

    const builtinRow = [...mount.querySelectorAll('.publisher-feeds-channel-row')].find(r =>
      r.textContent?.includes('NASA'),
    )!
    expect(builtinRow.classList.contains('publisher-feeds-channel-row-off')).toBe(true)
    const toggle = builtinRow.querySelector('button') as HTMLButtonElement
    expect(toggle.textContent).toBe('Enable')

    toggle.click()
    await flush()
    const call = fetchFn.mock.calls.find(c => String(c[0]).includes(`/youtube-channels/${NASA_CHANNEL}`))
    expect(call).toBeTruthy()
    expect((call![1] as RequestInit).method).toBe('POST')
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ disabled: false })
  })

  it('shows an unavailable note (no add form) when the channels endpoint is missing (older deploy)', async () => {
    const routes = baseRoutes()
    // Route missing on an older deploy → 404.
    routes['/api/v1/publish/media/youtube-channels'] = { status: 404, body: { error: 'not_found' } }
    await renderFeedsPage(mount, { fetchFn: mockFetch(routes) })
    // The News feeds tab still renders; the Media channels tab shows a
    // note instead of the allowlist UI, and the add-channel form is gone.
    expect(mount.querySelector('.publisher-feeds-row')).not.toBeNull()
    expect(mount.textContent).toContain("Media-channel management isn't available")
    expect(mount.querySelector('#feeds-channel-url')).toBeNull()
  })

  it('adding a channel by URL POSTs { url } to the channels endpoint', async () => {
    const routes = baseRoutes()
    routes['POST /api/v1/publish/media/youtube-channels'] = {
      status: 201,
      body: { channel: { channelId: CUSTOM_CHANNEL, channelName: 'City Museum', builtin: false } },
    }
    const fetchFn = mockFetch(routes)
    await renderFeedsPage(mount, { fetchFn })

    const addBtn = [...mount.querySelectorAll('button')].find(b => b.textContent === 'Add channel') as HTMLButtonElement
    // Empty → client-side error, no POST.
    addBtn.click()
    await flush()
    expect(fetchFn.mock.calls.some(c => String(c[0]).endsWith('/youtube-channels') && (c[1]?.method ?? 'GET') === 'POST')).toBe(false)

    ;(mount.querySelector('#feeds-channel-url') as HTMLInputElement).value = 'https://youtube.com/@citymuseum'
    addBtn.click()
    await flush()
    const post = fetchFn.mock.calls.find(
      c => String(c[0]).endsWith('/youtube-channels') && (c[1]?.method ?? 'GET') === 'POST',
    )
    expect(JSON.parse(String(post![1]!.body))).toEqual({ url: 'https://youtube.com/@citymuseum' })
  })

  it('removing a custom channel DELETEs it', async () => {
    const routes = baseRoutes()
    routes[`DELETE /api/v1/publish/media/youtube-channels/${CUSTOM_CHANNEL}`] = { body: { removed: true } }
    const fetchFn = mockFetch(routes)
    await renderFeedsPage(mount, { fetchFn })
    const customRow = [...mount.querySelectorAll('.publisher-feeds-channel-row')].find(r =>
      r.textContent?.includes('City Museum'),
    )!
    ;(customRow.querySelector('button') as HTMLButtonElement).click()
    await flush()
    expect(
      fetchFn.mock.calls.some(
        c => String(c[0]).includes(`/youtube-channels/${CUSTOM_CHANNEL}`) && c[1]?.method === 'DELETE',
      ),
    ).toBe(true)
  })

  it('renders registered video sources and adds a new one', async () => {
    const routes = baseRoutes()
    routes['/api/v1/publish/media/video-sources'] = {
      body: {
        sources: [
          {
            id: 'VS1',
            label: 'NOAA Ocean Today',
            url: 'https://oceantoday.noaa.gov/videositemap.xml',
            attribution: 'NOAA Ocean Today',
            enabled: true,
            lastRunAt: '2026-07-17T10:00:00.000Z',
            lastRunStatus: 'ok',
            lastRunError: null,
            lastRunCount: 283,
          },
        ],
      },
    }
    routes['POST /api/v1/publish/media/video-sources'] = { status: 201, body: { source: {} } }
    const fetchFn = mockFetch(routes)
    await renderFeedsPage(mount, { fetchFn })

    // The registered source is listed with its indexed count.
    expect(mount.textContent).toContain('NOAA Ocean Today')
    expect(mount.textContent).toContain('283')

    // Add a new source via the form — scoped to the video-sources card
    // (its inputs share classes with the news-tab custom-feed form).
    const addBtn = [...mount.querySelectorAll('button')].find(b => b.textContent === 'Add video source')!
    const cardEl = addBtn.closest('.publisher-card')!
    const inputs = [...cardEl.querySelectorAll('.publisher-feeds-input')] as HTMLInputElement[]
    const urlInput = inputs.find(i => i.type === 'url')!
    const labelInput = inputs.find(i => i.type === 'text' && i.maxLength === 120)!
    labelInput.value = 'USGS Video'
    urlInput.value = 'https://usgs.example/videositemap.xml'
    addBtn.click()
    await flush()
    const post = fetchFn.mock.calls.find(
      c => String(c[0]).endsWith('/media/video-sources') && (c[1]?.method ?? 'GET') === 'POST',
    )
    expect(post).toBeTruthy()
    expect(JSON.parse(String(post![1]!.body))).toMatchObject({ label: 'USGS Video', url: 'https://usgs.example/videositemap.xml' })
  })

  it('Index now POSTs the refresh endpoint', async () => {
    const routes = baseRoutes()
    routes['POST /api/v1/publish/media/video-sources/refresh'] = {
      body: { fetched: 283, indexed: 283, embedded: 12, pruned: 0 },
    }
    const fetchFn = mockFetch(routes)
    await renderFeedsPage(mount, { fetchFn })
    const indexBtn = [...mount.querySelectorAll('button')].find(b => b.textContent === 'Index now')!
    indexBtn.click()
    await flush()
    expect(
      fetchFn.mock.calls.some(
        c => String(c[0]).endsWith('/video-sources/refresh') && c[1]?.method === 'POST',
      ),
    ).toBe(true)
  })

  describe('re-score events', () => {
    /** A fetch stub that serves a scripted sequence of rematch pages
     *  while every other route keeps its static body. */
    function rematchFetch(pages: { status?: number; body?: unknown }[]) {
      const routes = baseRoutes()
      let call = 0
      const base = mockFetch(routes)
      return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url)
        if (path.includes('/events/rematch')) {
          const page = pages[Math.min(call, pages.length - 1)]
          call += 1
          const status = page.status ?? 200
          return {
            ok: status >= 200 && status < 300,
            status,
            type: 'basic',
            json: async () => page.body ?? {},
            text: async () => JSON.stringify(page.body ?? {}),
          } as unknown as Response
        }
        return base(input, init)
      })
    }

    const clickRematch = async (fetchFn: ReturnType<typeof vi.fn>): Promise<void> => {
      await renderFeedsPage(mount, { fetchFn: fetchFn as unknown as typeof fetch })
      const btn = mount.querySelector('#feeds-rematch-run') as HTMLButtonElement | null
      expect(btn).toBeTruthy()
      btn!.click()
    }

    it('walks every page and totals the result', async () => {
      // Two full pages then a short one. The card must sum across all
      // three rather than report only the last.
      const fetchFn = rematchFetch([
        { body: { scanned: 25, rescored: 25, failed: 0, failedIds: [], nextCursor: 'EVT025', done: false } },
        { body: { scanned: 25, rescored: 24, failed: 1, failedIds: ['EVT030'], nextCursor: 'EVT050', done: false } },
        { body: { scanned: 4, rescored: 4, failed: 0, failedIds: [], nextCursor: null, done: true } },
      ])
      await clickRematch(fetchFn)
      await until(
        () => (mount.textContent ?? '').includes('Re-scored'),
        'the rematch walk to finish',
      )
      expect(mount.textContent).toContain('Re-scored 53 of 54 events. 1 failed.')
    })

    it('passes the cursor back on the next page', async () => {
      const fetchFn = rematchFetch([
        { body: { scanned: 25, rescored: 25, failed: 0, failedIds: [], nextCursor: 'EVT025', done: false } },
        { body: { scanned: 1, rescored: 1, failed: 0, failedIds: [], nextCursor: null, done: true } },
      ])
      await clickRematch(fetchFn)
      await until(
        () => (mount.textContent ?? '').includes('Re-scored'),
        'the rematch walk to finish',
      )
      const calls = fetchFn.mock.calls.filter(c => String(c[0]).includes('/events/rematch'))
      expect(calls).toHaveLength(2)
      // Every page asks for the full walk, not just the unscored rows:
      // a stale score is present-but-wrong rather than NULL, so the
      // unscored-only filter would skip what this button is for.
      expect(JSON.parse(String((calls[0][1] as RequestInit).body))).toEqual({ unscoredOnly: false })
      // First page starts with no cursor; the second resumes past it.
      expect(JSON.parse(String((calls[1][1] as RequestInit).body))).toEqual({
        unscoredOnly: false,
        after: 'EVT025',
      })
    })

    it('resumes from the page cap on a second click, and rewinds once finished', async () => {
      // "Run again to continue" has to be true. A cursor scoped to the
      // click handler would restart at the top and strand the tail of a
      // long backlog no matter how often it was clicked.
      const page = (cursor: string, done: boolean) => ({
        body: { scanned: 1, rescored: 1, failed: 0, failedIds: [], nextCursor: done ? null : cursor, done },
      })
      const fetchFn = rematchFetch([page('EVT001', false), page('', true)])
      await clickRematch(fetchFn)
      await until(() => (mount.textContent ?? '').includes('Re-scored'), 'the first walk to finish')

      const calls = () => fetchFn.mock.calls.filter(c => String(c[0]).includes('/events/rematch'))
      // Walk ran to completion, so the cursor rewinds: a later click
      // must start from the top rather than resume past the end.
      const before = calls().length
      const btn = mount.querySelector('#feeds-rematch-run') as HTMLButtonElement
      btn.click()
      await until(() => calls().length > before, 'the second walk to start')
      expect(JSON.parse(String((calls()[before][1] as RequestInit).body))).toEqual({ unscoredOnly: false })
    })

    it('surfaces a failure and re-enables the button', async () => {
      const fetchFn = rematchFetch([{ status: 500, body: { error: 'server' } }])
      await clickRematch(fetchFn)
      await until(
        () => (mount.textContent ?? '').includes('Could not re-score'),
        'the rematch error to render',
      )
      const btn = mount.querySelector('#feeds-rematch-run') as HTMLButtonElement
      expect(btn.disabled).toBe(false)
    })

    it('is absent for a non-privileged caller', async () => {
      const routes = baseRoutes()
      routes['/api/v1/publish/me'] = { body: { role: 'author', is_admin: false } }
      routes['/api/v1/publish/feeds'] = { status: 403, body: { error: 'forbidden_role' } }
      await renderFeedsPage(mount, { fetchFn: mockFetch(routes) })
      expect(mount.querySelector('#feeds-rematch-run')).toBeNull()
    })
  })
})
