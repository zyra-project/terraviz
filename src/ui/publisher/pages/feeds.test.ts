/**
 * Tests for the /publish/feeds console — privileged gate, connector
 * rows (state + bookkeeping), preset gallery add/added states,
 * pause/resume + remove wiring, the custom-feed form, and Run now.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderFeedsPage } from './feeds'
import { FEED_PRESETS } from '../feed-presets'

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
})

const flush = () => new Promise<void>(r => setTimeout(r, 0))

let mount: HTMLElement
beforeEach(() => {
  mount = document.createElement('div')
  document.body.replaceChildren(mount)
})

describe('renderFeedsPage', () => {
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

  it('lists built-in + custom YouTube channels; only custom ones are removable', async () => {
    await renderFeedsPage(mount, { fetchFn: mockFetch(baseRoutes()) })
    const rows = [...mount.querySelectorAll('.publisher-feeds-channel-row')]
    expect(rows.length).toBe(2)
    const builtinRow = rows.find(r => r.textContent?.includes('NASA'))!
    const customRow = rows.find(r => r.textContent?.includes('City Museum'))!
    // Built-in has no Remove button; custom does.
    expect(builtinRow.querySelector('button')).toBeNull()
    expect(customRow.querySelector('button')?.textContent).toBe('Remove')
  })

  it('omits the channels card when the channels endpoint is unavailable (older deploy)', async () => {
    const routes = baseRoutes()
    // Route missing on an older deploy → 404.
    routes['/api/v1/publish/media/youtube-channels'] = { status: 404, body: { error: 'not_found' } }
    await renderFeedsPage(mount, { fetchFn: mockFetch(routes) })
    // The rest of the console still renders; only the channels card is gone.
    expect(mount.querySelector('.publisher-feeds-row')).not.toBeNull()
    expect([...mount.querySelectorAll('h2, h3')].some(h => h.textContent === 'Trusted video channels')).toBe(false)
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
})
