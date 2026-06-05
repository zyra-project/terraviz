import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderFeaturedHeroPage } from './featured-hero'

const DS = 'DS000' + 'A'.repeat(21)

interface RouteSpec { status?: number; body?: unknown }

/** Build a fetch mock routing on `${method} ${pathWithoutQuery}`. The
 *  callback param matches `typeof fetch` so the mock is assignable to
 *  the page's `fetchFn` option without a cast. */
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

const baseRoutes = (): Record<string, RouteSpec> => ({
  '/api/v1/publish/me': { body: { role: 'staff', is_admin: false } },
  '/api/v1/publish/datasets': { body: { datasets: [{ id: DS, title: 'Live Storm', thumbnail_url: null }] } },
  '/api/v1/featured-hero': { body: { hero: null } },
})

const flush = () => new Promise<void>(r => setTimeout(r, 0))

let mount: HTMLElement
beforeEach(() => {
  mount = document.createElement('div')
  document.body.replaceChildren(mount)
})

describe('renderFeaturedHeroPage', () => {
  it('shows a restricted card for a non-privileged publisher', async () => {
    const routes = baseRoutes()
    routes['/api/v1/publish/me'] = { body: { role: 'community', is_admin: false } }
    await renderFeaturedHeroPage(mount, { fetchFn: mockFetch(routes) })
    expect(mount.querySelector('.publisher-hero-restricted')).not.toBeNull()
    expect(mount.querySelector('.publisher-hero-select')).toBeNull()
  })

  it('renders the form with dataset options for a privileged publisher', async () => {
    await renderFeaturedHeroPage(mount, { fetchFn: mockFetch(baseRoutes()) })
    const select = mount.querySelector('.publisher-hero-select') as HTMLSelectElement
    expect(select).not.toBeNull()
    // placeholder + one dataset
    expect(select.querySelectorAll('option')).toHaveLength(2)
    expect(select.querySelector(`option[value="${DS}"]`)?.textContent).toBe('Live Storm')
  })

  it('prefills the form from the current pin', async () => {
    const routes = baseRoutes()
    routes['/api/v1/featured-hero'] = {
      body: { hero: { datasetId: DS, window: { start: '2026-05-01T00:00:00.000Z', end: '2026-06-01T00:00:00.000Z' }, headline: 'Pinned' } },
    }
    await renderFeaturedHeroPage(mount, { fetchFn: mockFetch(routes) })
    expect((mount.querySelector('.publisher-hero-select') as HTMLSelectElement).value).toBe(DS)
    expect((mount.querySelector('#hero-headline') as HTMLInputElement).value).toBe('Pinned')
    expect(mount.querySelector('.hero-panel-title')?.textContent).toBe('Pinned')
  })

  it('blocks Set with no dataset selected (client-side)', async () => {
    const fetchFn = mockFetch(baseRoutes())
    await renderFeaturedHeroPage(mount, { fetchFn })
    const callsBefore = fetchFn.mock.calls.length
    ;(mount.querySelector('.publisher-btn-primary') as HTMLButtonElement).click()
    await flush()
    expect(mount.querySelector('.publisher-hero-status-error')?.textContent).toBeTruthy()
    // No write request fired.
    expect(fetchFn.mock.calls.length).toBe(callsBefore)
  })

  it('sends a PUT and reports success on Set', async () => {
    const routes = baseRoutes()
    routes['PUT /api/v1/publish/featured-hero'] = { body: { hero: { datasetId: DS, window: { start: '', end: '' } } } }
    const fetchFn = mockFetch(routes)
    await renderFeaturedHeroPage(mount, { fetchFn })
    ;(mount.querySelector('.publisher-hero-select') as HTMLSelectElement).value = DS
    ;(mount.querySelector('.publisher-btn-primary') as HTMLButtonElement).click()
    await flush()
    const putCall = fetchFn.mock.calls.find(c => (c[1] as RequestInit)?.method === 'PUT')
    expect(putCall).toBeTruthy()
    expect(mount.querySelector('.publisher-hero-status')?.textContent).toBe('Hero set.')
  })

  it('surfaces a validation error from the API on Set', async () => {
    const routes = baseRoutes()
    routes["PUT /api/v1/publish/featured-hero"] = { status: 400, body: { errors: [{ field: 'window', code: 'invalid_range', message: 'Bad window.' }] } }
    const fetchFn = mockFetch(routes)
    await renderFeaturedHeroPage(mount, { fetchFn })
    ;(mount.querySelector('.publisher-hero-select') as HTMLSelectElement).value = DS
    ;(mount.querySelector('.publisher-btn-primary') as HTMLButtonElement).click()
    await flush()
    expect(mount.querySelector('.publisher-hero-status-error')?.textContent).toBe('Bad window.')
  })

  it('sends a DELETE and reports cleared on Clear', async () => {
    const routes = baseRoutes()
    routes['/api/v1/featured-hero'] = {
      body: { hero: { datasetId: DS, window: { start: '2026-05-01T00:00:00.000Z', end: '2026-06-01T00:00:00.000Z' } } },
    }
    routes['DELETE /api/v1/publish/featured-hero'] = { status: 204 }
    const fetchFn = mockFetch(routes)
    await renderFeaturedHeroPage(mount, { fetchFn })
    ;(mount.querySelector('.publisher-btn:not(.publisher-btn-primary)') as HTMLButtonElement).click()
    await flush()
    const delCall = fetchFn.mock.calls.find(c => (c[1] as RequestInit)?.method === 'DELETE')
    expect(delCall).toBeTruthy()
    expect(mount.querySelector('.publisher-hero-status')?.textContent).toBe('Hero cleared.')
  })

  it('clears prior error styling when Clear succeeds', async () => {
    const routes = baseRoutes()
    routes['/api/v1/featured-hero'] = {
      body: { hero: { datasetId: DS, window: { start: '2026-05-01T00:00:00.000Z', end: '2026-06-01T00:00:00.000Z' } } },
    }
    // First DELETE errors (server), second succeeds.
    let calls = 0
    const fetchFn = mockFetch(routes)
    const orig = fetchFn.getMockImplementation()!
    fetchFn.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        calls++
        return { ok: calls > 1, status: calls > 1 ? 204 : 500, type: 'basic', json: async () => ({}), text: async () => '' } as unknown as Response
      }
      return orig(input, init)
    })
    await renderFeaturedHeroPage(mount, { fetchFn })
    const clearBtn = mount.querySelector('.publisher-btn:not(.publisher-btn-primary)') as HTMLButtonElement
    clearBtn.click(); await flush()
    const status = mount.querySelector('.publisher-hero-status') as HTMLElement
    expect(status.classList.contains('publisher-hero-status-error')).toBe(true) // first attempt errored
    clearBtn.click(); await flush()
    expect(status.textContent).toBe('Hero cleared.')
    expect(status.classList.contains('publisher-hero-status-error')).toBe(false) // styling cleared
  })

  it('mounts inside a publisher-shell main landmark', async () => {
    await renderFeaturedHeroPage(mount, { fetchFn: mockFetch(baseRoutes()) })
    expect(mount.querySelector('main.publisher-shell')).not.toBeNull()
    // The restricted path also gets the landmark.
    const r = baseRoutes()
    r['/api/v1/publish/me'] = { body: { role: 'community', is_admin: false } }
    mount.replaceChildren()
    await renderFeaturedHeroPage(mount, { fetchFn: mockFetch(r) })
    expect(mount.querySelector('main.publisher-shell')).not.toBeNull()
  })

  it('renders an error card (no form) when a required fetch fails', async () => {
    const routes = baseRoutes()
    routes['/api/v1/publish/datasets'] = { status: 500 }
    await renderFeaturedHeroPage(mount, { fetchFn: mockFetch(routes) })
    expect(mount.querySelector('.publisher-hero-select')).toBeNull()
    expect(mount.querySelector('main.publisher-shell')).not.toBeNull()
  })

  it('keeps Clear disabled after a failed Set (no pin exists)', async () => {
    const routes = baseRoutes() // hero: null → no pin
    routes['PUT /api/v1/publish/featured-hero'] = { status: 500 }
    await renderFeaturedHeroPage(mount, { fetchFn: mockFetch(routes) })
    const clearBtn = mount.querySelector('.publisher-btn:not(.publisher-btn-primary)') as HTMLButtonElement
    expect(clearBtn.disabled).toBe(true)
    ;(mount.querySelector('.publisher-hero-select') as HTMLSelectElement).value = DS
    ;(mount.querySelector('.publisher-btn-primary') as HTMLButtonElement).click()
    await flush()
    expect(clearBtn.disabled).toBe(true) // failed Set must not enable Clear
  })

  it('enables Clear after a successful Set', async () => {
    const routes = baseRoutes()
    routes['PUT /api/v1/publish/featured-hero'] = { body: { hero: { datasetId: DS, window: { start: '', end: '' } } } }
    await renderFeaturedHeroPage(mount, { fetchFn: mockFetch(routes) })
    const clearBtn = mount.querySelector('.publisher-btn:not(.publisher-btn-primary)') as HTMLButtonElement
    expect(clearBtn.disabled).toBe(true)
    ;(mount.querySelector('.publisher-hero-select') as HTMLSelectElement).value = DS
    ;(mount.querySelector('.publisher-btn-primary') as HTMLButtonElement).click()
    await flush()
    expect(clearBtn.disabled).toBe(false)
  })
})
