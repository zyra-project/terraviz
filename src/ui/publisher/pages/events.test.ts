// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderEventsPage } from './events'

const DS = 'DS000' + 'A'.repeat(21)
const EVT = '01HEVENT00000000000000000A'

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

const oneEvent = () => ({
  events: [
    {
      id: EVT,
      title: 'Hurricane makes landfall',
      summary: 'A category 4 storm reached the coast.',
      source: { name: 'NOAA', url: 'https://example.gov/storm', publishedAt: '2026-06-25T00:00:00Z' },
      occurredStart: '2026-06-25T12:00:00Z',
      status: 'proposed',
      links: [
        { datasetId: DS, datasetTitle: 'Live Storm', score: 0.9, signals: { geo: null, temporal: 1 }, status: 'proposed' },
      ],
    },
  ],
})

const baseRoutes = (): Record<string, RouteSpec> => ({
  '/api/v1/publish/me': { body: { role: 'admin', is_admin: true } },
  '/api/v1/publish/events': { body: oneEvent() },
})

const flush = () => new Promise<void>(r => setTimeout(r, 0))
/** Drain the chained async hops (send → reload-fetch → re-render). */
const settle = async () => {
  for (let i = 0; i < 6; i++) await flush()
}

let mount: HTMLElement
beforeEach(() => {
  mount = document.createElement('div')
  document.body.replaceChildren(mount)
})

describe('renderEventsPage', () => {
  it('a non-admin publisher reads the queue but gets no feed-Refresh button', async () => {
    const routes = baseRoutes()
    routes['/api/v1/publish/me'] = { body: { role: 'publisher', is_admin: false } }
    const fetchFn = mockFetch(routes)
    await renderEventsPage(mount, { fetchFn })
    // No restricted wall — the queue renders.
    expect(mount.querySelector('.publisher-events-restricted')).toBeNull()
    expect(mount.querySelector('.publisher-events-queue-title')?.textContent).toBe('Hurricane makes landfall')
    // The events queue IS fetched (read is open).
    expect(fetchFn.mock.calls.some(c => String(c[0]).includes('/publish/events'))).toBe(true)
    // The feed-Refresh action is admin-only; only New event shows.
    const toolbarButtons = mount.querySelectorAll<HTMLButtonElement>('.publisher-events-toolbar button')
    expect(toolbarButtons).toHaveLength(1)
    expect(toolbarButtons[0].textContent).toBe('New event')
  })

  it('a non-admin publisher sees an owned event read-only when can_edit is false', async () => {
    const routes = baseRoutes()
    routes['/api/v1/publish/me'] = { body: { role: 'publisher', is_admin: false } }
    const ev = oneEvent()
    ;(ev.events[0] as { can_edit?: boolean }).can_edit = false
    routes['/api/v1/publish/events'] = { body: ev }
    await renderEventsPage(mount, { fetchFn: mockFetch(routes) })
    // The detail renders, but the approve/reject decision controls do not.
    expect(mount.querySelector('.publisher-events-detail-title')?.textContent).toBe('Hurricane makes landfall')
    expect(mount.querySelector('.publisher-events-decision-approve')).toBeNull()
    expect(mount.querySelector('.publisher-events-readonly-notice')).not.toBeNull()
    // The pairing row shows, but without its ✓ / ✕ decision buttons.
    expect(mount.querySelector('.publisher-events-pairing-name')?.textContent).toBe('Live Storm')
    expect(mount.querySelector('.publisher-events-icon-btn')).toBeNull()
  })

  it('renders the selected event detail with source, title, and a pairing row', async () => {
    await renderEventsPage(mount, { fetchFn: mockFetch(baseRoutes()) })
    // The first event is auto-selected into the detail pane.
    expect(mount.querySelector('.publisher-events-detail-title')?.textContent).toBe('Hurricane makes landfall')
    const sourceLink = mount.querySelector('.publisher-events-source-link') as HTMLAnchorElement
    expect(sourceLink?.href).toContain('example.gov/storm')
    expect(mount.querySelector('.publisher-events-pairing-name')?.textContent).toBe('Live Storm')
    // …and the queue lists it on the left.
    expect(mount.querySelector('.publisher-events-queue-title')?.textContent).toBe('Hurricane makes landfall')
  })

  it('shows the empty state when there are no events', async () => {
    const routes = baseRoutes()
    routes['/api/v1/publish/events'] = { body: { events: [] } }
    await renderEventsPage(mount, { fetchFn: mockFetch(routes) })
    expect(mount.querySelector('.publisher-empty-message')).not.toBeNull()
    expect(mount.querySelector('.publisher-events-detail')).toBeNull()
  })

  it('defaults to the proposed filter and re-fetches at the chosen status', async () => {
    const fetchFn = mockFetch(baseRoutes())
    await renderEventsPage(mount, { fetchFn })
    // Initial load requests the proposed backlog.
    expect(fetchFn.mock.calls.some(c => String(c[0]).includes('/publish/events?status=proposed'))).toBe(true)
    expect(mount.querySelector('.publisher-events-filter-active')?.textContent).toBe('Proposed')

    // Switch to Approved (the route stubs ignore the query, but the
    // request URL carries the status so the backend would filter).
    const filterButtons = mount.querySelectorAll<HTMLButtonElement>('.publisher-events-filters button')
    const approvedBtn = Array.from(filterButtons).find(b => b.textContent === 'Approved')!
    approvedBtn.click()
    await settle()

    expect(fetchFn.mock.calls.some(c => String(c[0]).includes('/publish/events?status=approved'))).toBe(true)
    expect(mount.querySelector('.publisher-events-filter-active')?.textContent).toBe('Approved')
    // The event-level Reject control is reachable in the detail pane.
    expect(mount.querySelector('.publisher-events-decision-reject')).not.toBeNull()
  })

  it('approves the event via POST and reloads (it leaves the proposed view)', async () => {
    const routes = baseRoutes()
    routes[`POST /api/v1/publish/events/${EVT}`] = { body: { event: { status: 'approved' }, links: [] } }
    const fetchFn = mockFetch(routes)
    await renderEventsPage(mount, { fetchFn })

    const approve = mount.querySelector('.publisher-events-decision-approve') as HTMLButtonElement
    approve.click()
    await settle()

    const post = fetchFn.mock.calls.find(c => (c[1] as RequestInit)?.method === 'POST')
    expect(post).toBeTruthy()
    expect(String(post![0])).toBe(`/api/v1/publish/events/${EVT}`)
    expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({ event: 'approve' })
    // approved no longer matches the active `proposed` filter, so the
    // queue re-fetches to stay consistent (the card leaves the view).
    const eventsGets = fetchFn.mock.calls.filter(
      c => String(c[0]).split('?')[0].endsWith('/publish/events') && (c[1]?.method ?? 'GET') === 'GET',
    )
    expect(eventsGets.length).toBeGreaterThanOrEqual(2)
  })

  it('updates the badge in place when the new status still matches the view (All)', async () => {
    const routes = baseRoutes()
    routes[`POST /api/v1/publish/events/${EVT}`] = { body: { event: { status: 'approved' }, links: [] } }
    const fetchFn = mockFetch(routes)
    await renderEventsPage(mount, { fetchFn })

    const allBtn = Array.from(mount.querySelectorAll<HTMLButtonElement>('.publisher-events-filters button')).find(
      b => b.textContent === 'All',
    )!
    allBtn.click()
    await settle()

    const approve = mount.querySelector('.publisher-events-decision-approve') as HTMLButtonElement
    approve.click()
    await settle()

    // 'approved' still matches the All view → no reload, badge flips in place.
    const badge = mount.querySelector('.publisher-events-detail-header .publisher-events-badge')
    expect(badge?.classList.contains('publisher-events-badge-approved')).toBe(true)
  })

  it('refreshes the feed via POST and reloads the queue with a result notice', async () => {
    const routes = baseRoutes()
    routes['POST /api/v1/publish/events/refresh'] = { body: { created: 2, refreshed: 1, failed: 0 } }
    const fetchFn = mockFetch(routes)
    await renderEventsPage(mount, { fetchFn })

    const toolbarButtons = mount.querySelectorAll<HTMLButtonElement>('.publisher-events-toolbar button')
    const refreshBtn = toolbarButtons[0] // Refresh feed (non-primary) precedes New event
    refreshBtn.click()
    await settle()

    const refreshPost = fetchFn.mock.calls.find(
      c => String(c[0]).includes('/events/refresh') && (c[1] as RequestInit)?.method === 'POST',
    )
    expect(refreshPost).toBeTruthy()
    // The queue is re-fetched after a successful pull.
    const eventsGets = fetchFn.mock.calls.filter(
      c => String(c[0]).split('?')[0].endsWith('/publish/events') && (c[1]?.method ?? 'GET') === 'GET',
    )
    expect(eventsGets.length).toBeGreaterThanOrEqual(2)
    // The result summary survives the re-render.
    expect(mount.querySelector('.publisher-events-actions-status')?.textContent).toContain('2')
  })

  it('opens the new-event drawer and creates a manual event via POST', async () => {
    const routes = baseRoutes()
    routes['/api/v1/publish/datasets'] = { body: { datasets: [], next_cursor: null } }
    routes['POST /api/v1/publish/events'] = { status: 201, body: { created: true, event: { id: EVT, status: 'proposed' }, links: [] } }
    const fetchFn = mockFetch(routes)
    await renderEventsPage(mount, { fetchFn })

    const toolbarButtons = mount.querySelectorAll<HTMLButtonElement>('.publisher-events-toolbar button')
    toolbarButtons[1].click() // New event → drawer (mounts on document.body)
    const drawer = document.querySelector('.publisher-events-drawer')
    expect(drawer).not.toBeNull()
    expect(document.querySelector('.publisher-events-drawer-pair')).not.toBeNull()

    const inputs = document.querySelectorAll<HTMLInputElement>('.publisher-events-drawer-compose input')
    inputs[0].value = 'Manual storm' // title
    inputs[1].value = 'NOAA' // source name
    inputs[2].value = 'https://example.gov/manual' // source url
    const saveBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('.publisher-events-drawer-actions button'))
      .find(b => b.classList.contains('publisher-button-primary'))!
    saveBtn.click()
    await settle()

    const createPost = fetchFn.mock.calls.find(
      c => String(c[0]).split('?')[0].endsWith('/publish/events') && (c[1] as RequestInit)?.method === 'POST',
    )
    expect(createPost).toBeTruthy()
    const sent = JSON.parse((createPost![1] as RequestInit).body as string)
    expect(sent).toMatchObject({ title: 'Manual storm', source: { name: 'NOAA', url: 'https://example.gov/manual' }, datasetIds: [] })
    // No feed key — this is a hand-authored event.
    expect(sent.feedId).toBeUndefined()
    // The drawer closes and the queue reloads (selecting the new event).
    expect(document.querySelector('.publisher-events-drawer')).toBeNull()
  })

  it('approves a single link via POST with the link decision', async () => {
    const routes = baseRoutes()
    routes[`POST /api/v1/publish/events/${EVT}`] = { body: { event: null, links: [] } }
    const fetchFn = mockFetch(routes)
    await renderEventsPage(mount, { fetchFn })

    const linkApprove = mount.querySelector('.publisher-events-pairing .publisher-events-icon-btn-approve') as HTMLButtonElement
    linkApprove.click()
    await flush()

    const post = fetchFn.mock.calls.find(c => (c[1] as RequestInit)?.method === 'POST')
    expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({
      links: [{ datasetId: DS, decision: 'approve' }],
    })
  })
})
