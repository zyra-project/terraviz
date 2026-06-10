import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderDatasetsPage } from './datasets'

interface RawDataset {
  id: string
  slug: string
  title: string
  abstract: string | null
  organization: string | null
  format: string
  visibility: string
  created_at: string
  updated_at: string
  published_at: string | null
  retracted_at: string | null
  publisher_id: string | null
  legacy_id: string | null
}

function dataset(overrides: Partial<RawDataset> = {}): RawDataset {
  return {
    id: '01ABC',
    slug: 'sst-anomaly-2026-04',
    title: 'Sea Surface Temperature Anomaly — April 2026',
    abstract: null,
    organization: 'NOAA/PMEL',
    format: 'video/mp4',
    visibility: 'public',
    created_at: '2026-04-30T12:00:00Z',
    updated_at: '2026-04-30T12:00:00Z',
    published_at: '2026-04-30T12:00:00Z',
    retracted_at: null,
    publisher_id: 'PUB1',
    legacy_id: null,
    ...overrides,
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('renderDatasetsPage', () => {
  const originalPath = window.location.pathname + window.location.search
  let mount: HTMLDivElement

  beforeEach(() => {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    sessionStorage.clear()
  })

  afterEach(() => {
    window.history.replaceState(null, '', originalPath)
  })

  it('fetches with status=draft by default and renders three tabs', async () => {
    window.history.replaceState(null, '', '/publish/datasets')
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ datasets: [], next_cursor: null }))
    await renderDatasetsPage(mount, { fetchFn: fetchFn as unknown as typeof fetch })

    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining('status=draft'),
      expect.anything(),
    )
    const tabs = mount.querySelectorAll('.publisher-tab')
    expect(tabs.length).toBe(3)
    expect(Array.from(tabs).map(t => t.textContent)).toEqual([
      'Drafts',
      'Published',
      'Retracted',
    ])
  })

  it('reads the active status from the URL query string', async () => {
    window.history.replaceState(null, '', '/publish/datasets?status=published')
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ datasets: [], next_cursor: null }))
    await renderDatasetsPage(mount, { fetchFn: fetchFn as unknown as typeof fetch })

    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining('status=published'),
      expect.anything(),
    )
    const active = mount.querySelector('.publisher-tab-active')
    expect(active?.textContent).toBe('Published')
    expect(active?.getAttribute('aria-selected')).toBe('true')
  })

  it('falls back to draft on an invalid ?status= value', async () => {
    window.history.replaceState(null, '', '/publish/datasets?status=garbage')
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ datasets: [], next_cursor: null }))
    await renderDatasetsPage(mount, { fetchFn: fetchFn as unknown as typeof fetch })
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining('status=draft'),
      expect.anything(),
    )
  })

  it('renders a table row per dataset with a link to the detail page', async () => {
    window.history.replaceState(null, '', '/publish/datasets?status=published')
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        datasets: [
          dataset({ id: 'A', title: 'Dataset A', slug: 'dataset-a' }),
          dataset({ id: 'B', title: 'Dataset B', slug: 'dataset-b' }),
        ],
        next_cursor: null,
      }),
    )
    await renderDatasetsPage(mount, { fetchFn: fetchFn as unknown as typeof fetch })

    const rows = mount.querySelectorAll('tbody tr')
    expect(rows.length).toBe(2)
    const firstLink = rows[0].querySelector<HTMLAnchorElement>('.publisher-row-link')
    expect(firstLink?.textContent).toBe('Dataset A')
    expect(firstLink?.getAttribute('href')).toBe('/publish/datasets/A')
  })

  it('intercepts a plain title-link click and routes through the portal router', async () => {
    window.history.replaceState(null, '', '/publish/datasets?status=published')
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        datasets: [dataset({ id: 'A', title: 'Dataset A' })],
        next_cursor: null,
      }),
    )
    const routerNavigate = vi.fn<(path: string) => void>()
    await renderDatasetsPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate,
    })
    const link = mount.querySelector<HTMLAnchorElement>('.publisher-row-link')!
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    link.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(routerNavigate).toHaveBeenCalledWith('/publish/datasets/A')
  })

  it('lets a cmd-clicked title link fall through to the browser', async () => {
    window.history.replaceState(null, '', '/publish/datasets?status=published')
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        datasets: [dataset({ id: 'A' })],
        next_cursor: null,
      }),
    )
    const routerNavigate = vi.fn<(path: string) => void>()
    await renderDatasetsPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate,
    })
    const link = mount.querySelector<HTMLAnchorElement>('.publisher-row-link')!
    const ev = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      metaKey: true,
    })
    link.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
    expect(routerNavigate).not.toHaveBeenCalled()
  })

  it('renders a draft-state badge for rows with no published_at and no retracted_at', async () => {
    window.history.replaceState(null, '', '/publish/datasets?status=draft')
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        datasets: [dataset({ published_at: null, retracted_at: null })],
        next_cursor: null,
      }),
    )
    await renderDatasetsPage(mount, { fetchFn: fetchFn as unknown as typeof fetch })
    const badge = mount.querySelector<HTMLElement>('.publisher-badge-status')
    expect(badge?.textContent).toBe('Draft')
  })

  it('renders the count via the i18n plural helper', async () => {
    window.history.replaceState(null, '', '/publish/datasets')
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ datasets: [dataset({ id: 'X' })], next_cursor: null }),
    )
    await renderDatasetsPage(mount, { fetchFn: fetchFn as unknown as typeof fetch })
    const count = mount.querySelector('.publisher-list-count')
    expect(count?.textContent).toBe('1 dataset')
  })

  it('shows the Drafts empty state when the API returns []', async () => {
    window.history.replaceState(null, '', '/publish/datasets?status=draft')
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ datasets: [], next_cursor: null }),
    )
    await renderDatasetsPage(mount, { fetchFn: fetchFn as unknown as typeof fetch })
    expect(mount.textContent).toContain('No drafts yet')
  })

  it('shows the Published empty state on the published tab', async () => {
    window.history.replaceState(null, '', '/publish/datasets?status=published')
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ datasets: [], next_cursor: null }),
    )
    await renderDatasetsPage(mount, { fetchFn: fetchFn as unknown as typeof fetch })
    expect(mount.textContent).toContain('No published datasets yet')
  })

  it('renders a Load more button when next_cursor is present', async () => {
    window.history.replaceState(null, '', '/publish/datasets')
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ datasets: [dataset()], next_cursor: 'CURSOR1' }),
    )
    await renderDatasetsPage(mount, { fetchFn: fetchFn as unknown as typeof fetch })
    const loadMore = mount.querySelector<HTMLButtonElement>('.publisher-load-more')
    expect(loadMore?.textContent).toBe('Load more')
  })

  it('hides the Load more button when next_cursor is null', async () => {
    window.history.replaceState(null, '', '/publish/datasets')
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ datasets: [dataset()], next_cursor: null }),
    )
    await renderDatasetsPage(mount, { fetchFn: fetchFn as unknown as typeof fetch })
    expect(mount.querySelector('.publisher-load-more')).toBeNull()
  })

  it('clicking Load more fetches the next cursor and appends rows in place', async () => {
    window.history.replaceState(null, '', '/publish/datasets')
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          datasets: [dataset({ id: 'A', title: 'A' })],
          next_cursor: 'CUR1',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          datasets: [dataset({ id: 'B', title: 'B' })],
          next_cursor: null,
        }),
      )
    await renderDatasetsPage(mount, { fetchFn: fetchFn as unknown as typeof fetch })

    expect(mount.querySelectorAll('tbody tr').length).toBe(1)

    const btn = mount.querySelector<HTMLButtonElement>('.publisher-load-more')!
    btn.click()
    // Allow the async fetch chain to settle.
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(fetchFn.mock.calls[1][0]).toContain('cursor=CUR1')
    expect(mount.querySelectorAll('tbody tr').length).toBe(2)
    expect(mount.querySelector('.publisher-load-more')).toBeNull()
  })

  it('clicking a tab calls routerNavigate with the new ?status= URL', async () => {
    window.history.replaceState(null, '', '/publish/datasets?status=draft')
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ datasets: [], next_cursor: null }),
    )
    const routerNavigate = vi.fn()
    await renderDatasetsPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate,
    })

    const published = Array.from(
      mount.querySelectorAll<HTMLAnchorElement>('.publisher-tab'),
    ).find(t => t.textContent === 'Published')!
    published.click()

    expect(routerNavigate).toHaveBeenCalledWith('/publish/datasets?status=published')
  })

  it('lets cmd-click on a tab fall through to the browser default', async () => {
    window.history.replaceState(null, '', '/publish/datasets?status=draft')
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ datasets: [], next_cursor: null }),
    )
    const routerNavigate = vi.fn()
    await renderDatasetsPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate,
    })

    const published = Array.from(
      mount.querySelectorAll<HTMLAnchorElement>('.publisher-tab'),
    ).find(t => t.textContent === 'Published')!
    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      metaKey: true,
    })
    published.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(routerNavigate).not.toHaveBeenCalled()
  })

  it('renders the server-error card on a 5xx response', async () => {
    window.history.replaceState(null, '', '/publish/datasets')
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 503 }))
    await renderDatasetsPage(mount, { fetchFn: fetchFn as unknown as typeof fetch })
    expect(mount.querySelector('.publisher-error')?.getAttribute('role')).toBe('alert')
    expect(mount.textContent).toContain('server returned an error')
  })

  it('delegates session errors to the shared handler (auto-warmup on fresh tab)', async () => {
    window.history.replaceState(null, '', '/publish/datasets')
    sessionStorage.clear()
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 401 }))
    const navigate = vi.fn()
    await renderDatasetsPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      navigate,
    })
    expect(navigate).toHaveBeenCalledOnce()
    expect(mount.querySelector('.publisher-error')).toBeNull()
  })
})

describe('renderDatasetsPage — delete action', () => {
  const originalPath = window.location.pathname + window.location.search
  let mount: HTMLDivElement

  beforeEach(() => {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    sessionStorage.clear()
    window.history.replaceState(null, '', '/publish/datasets')
  })

  afterEach(() => {
    window.history.replaceState(null, '', originalPath)
    vi.restoreAllMocks()
  })

  function listThen(deleteResponse: Response, rows: RawDataset[]) {
    // First call: the list fetch; subsequent: the DELETE.
    return vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ datasets: rows, next_cursor: null }))
      .mockResolvedValue(deleteResponse)
  }

  it('shows the delete button only for non-published rows', async () => {
    const fetchFn = listThen(jsonResponse({ deleted_id: 'x' }), [
      dataset({ id: '01AAA', published_at: null }),
      dataset({ id: '01BBB' }), // published
    ])
    await renderDatasetsPage(mount, { fetchFn: fetchFn as unknown as typeof fetch })
    const rows = mount.querySelectorAll('tbody tr')
    expect(rows[0].querySelector('.publisher-row-delete')).not.toBeNull()
    expect(rows[1].querySelector('.publisher-row-delete')).toBeNull()
  })

  it('does not call DELETE when the confirm dialog is cancelled', async () => {
    const fetchFn = listThen(jsonResponse({ deleted_id: '01AAA' }), [
      dataset({ id: '01AAA', published_at: null }),
    ])
    await renderDatasetsPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      confirm: () => false,
    })
    mount.querySelector<HTMLButtonElement>('.publisher-row-delete')?.click()
    await Promise.resolve()
    expect(fetchFn).toHaveBeenCalledTimes(1) // list only
    expect(mount.querySelector('tbody tr')).not.toBeNull()
  })

  it('removes the row after a confirmed, successful DELETE', async () => {
    const fetchFn = listThen(jsonResponse({ deleted_id: '01AAA' }), [
      dataset({ id: '01AAA', published_at: null }),
    ])
    await renderDatasetsPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      confirm: () => true,
    })
    mount.querySelector<HTMLButtonElement>('.publisher-row-delete')?.click()
    await vi.waitFor(() => {
      expect(mount.querySelector('tbody tr')).toBeNull()
    })
    expect(fetchFn).toHaveBeenLastCalledWith(
      '/api/v1/publish/datasets/01AAA',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('shows an inline error and keeps the row when DELETE fails', async () => {
    const fetchFn = listThen(
      new Response(JSON.stringify({ error: 'published' }), { status: 409 }),
      [dataset({ id: '01AAA', published_at: null })],
    )
    await renderDatasetsPage(mount, {
      fetchFn: fetchFn as unknown as typeof fetch,
      confirm: () => true,
    })
    mount.querySelector<HTMLButtonElement>('.publisher-row-delete')?.click()
    await vi.waitFor(() => {
      expect(
        mount.querySelector('.publisher-row-action-status-error')?.textContent,
      ).toBeTruthy()
    })
    expect(mount.querySelector('tbody tr')).not.toBeNull()
  })
})
