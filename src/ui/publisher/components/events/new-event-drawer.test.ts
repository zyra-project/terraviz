import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openNewEventDrawer } from './new-event-drawer'

const DS0 = 'DS000' + 'A'.repeat(21)
const DS1 = 'DS001' + 'A'.repeat(21)
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

const datasetsRoute = () => ({
  datasets: [
    { id: DS0, slug: 'live-storm', title: 'Live Storm', abstract: null, organization: 'NOAA', format: 'video/mp4', visibility: 'public', created_at: '', updated_at: '', published_at: '2026-01-01T00:00:00Z', retracted_at: null, publisher_id: null, legacy_id: null },
    { id: DS1, slug: 'sea-temp', title: 'Sea Surface Temperature', abstract: null, organization: 'NOAA', format: 'video/mp4', visibility: 'public', created_at: '', updated_at: '', published_at: '2026-01-01T00:00:00Z', retracted_at: null, publisher_id: null, legacy_id: null },
  ],
  next_cursor: null,
})

const baseRoutes = (): Record<string, RouteSpec> => ({
  '/api/v1/publish/datasets': { body: datasetsRoute() },
  'POST /api/v1/publish/events': { status: 201, body: { created: true, event: { id: EVT, status: 'proposed' }, links: [] } },
})

const flush = () => new Promise<void>(r => setTimeout(r, 0))
const settle = async () => { for (let i = 0; i < 5; i++) await flush() }

beforeEach(() => {
  document.body.replaceChildren()
})

describe('openNewEventDrawer', () => {
  it('mounts a focus-trapped dialog with both panes', async () => {
    openNewEventDrawer({ fetchFn: mockFetch(baseRoutes()), onCreated: () => {} })
    const drawer = document.querySelector('.publisher-events-drawer')
    expect(drawer).not.toBeNull()
    expect(drawer?.getAttribute('role')).toBe('dialog')
    expect(drawer?.getAttribute('aria-modal')).toBe('true')
    expect(document.querySelector('.publisher-events-drawer-compose')).not.toBeNull()
    expect(document.querySelector('.publisher-events-drawer-pair')).not.toBeNull()
  })

  it('filters candidates by the search query and toggles a pairing', async () => {
    openNewEventDrawer({ fetchFn: mockFetch(baseRoutes()), onCreated: () => {} })
    await settle() // dataset index loads, search enables

    const search = document.querySelector('.publisher-events-drawer-pair input') as HTMLInputElement
    expect(search.disabled).toBe(false)
    search.value = 'sea'
    search.dispatchEvent(new Event('input'))

    const rows = document.querySelectorAll('.publisher-events-drawer-candidate')
    expect(rows.length).toBe(1)
    expect(rows[0].querySelector('.publisher-events-drawer-candidate-name')?.textContent).toBe('Sea Surface Temperature')

    ;(rows[0].querySelector('button') as HTMLButtonElement).click()
    expect(document.querySelector('.publisher-events-drawer-paired')?.textContent).toContain('1')
    expect(document.querySelector('.publisher-events-drawer-candidate-on')).not.toBeNull()
  })

  it('posts the compose body plus the hand-picked datasetIds, then fires onCreated', async () => {
    const fetchFn = mockFetch(baseRoutes())
    const onCreated = vi.fn()
    openNewEventDrawer({ fetchFn, onCreated })
    await settle()

    // Pair one dataset.
    const search = document.querySelector('.publisher-events-drawer-pair input') as HTMLInputElement
    search.value = 'live'
    search.dispatchEvent(new Event('input'))
    ;(document.querySelector('.publisher-events-drawer-candidate button') as HTMLButtonElement).click()

    // Fill the compose fields (inputs: title, sourceName, sourceUrl, …).
    const inputs = document.querySelectorAll<HTMLInputElement>('.publisher-events-drawer-compose input')
    inputs[0].value = 'Manual storm'
    inputs[1].value = 'NOAA'
    inputs[2].value = 'https://example.gov/manual'

    const saveBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('.publisher-events-drawer-actions button'))
      .find(b => b.classList.contains('publisher-btn-primary'))!
    saveBtn.click()
    await settle()

    const createPost = fetchFn.mock.calls.find(
      c => String(c[0]).split('?')[0].endsWith('/publish/events') && (c[1] as RequestInit)?.method === 'POST',
    )
    expect(createPost).toBeTruthy()
    const sent = JSON.parse((createPost![1] as RequestInit).body as string)
    expect(sent).toMatchObject({
      title: 'Manual storm',
      source: { name: 'NOAA', url: 'https://example.gov/manual' },
      datasetIds: [DS0],
    })
    expect(onCreated).toHaveBeenCalledWith(EVT)
    // Drawer closes on success.
    expect(document.querySelector('.publisher-events-drawer')).toBeNull()
  })

  it('composes the date + time pickers into an ISO occurredStart', async () => {
    const fetchFn = mockFetch(baseRoutes())
    openNewEventDrawer({ fetchFn, onCreated: () => {} })
    await settle()

    const inputs = document.querySelectorAll<HTMLInputElement>('.publisher-events-drawer-compose input')
    inputs[0].value = 'Manual storm'
    inputs[1].value = 'NOAA'
    inputs[2].value = 'https://example.gov/manual'
    // First date + time inputs belong to the Start-time picker.
    const dateInput = document.querySelector<HTMLInputElement>('.publisher-events-drawer-compose input[type="date"]')!
    const timeInput = document.querySelector<HTMLInputElement>('.publisher-events-drawer-compose input[type="time"]')!
    dateInput.value = '2026-06-26'
    timeInput.value = '12:00'

    ;(Array.from(document.querySelectorAll<HTMLButtonElement>('.publisher-events-drawer-actions button'))
      .find(b => b.classList.contains('publisher-btn-primary')) as HTMLButtonElement).click()
    await settle()

    const createPost = fetchFn.mock.calls.find(
      c => String(c[0]).split('?')[0].endsWith('/publish/events') && (c[1] as RequestInit)?.method === 'POST',
    )
    const sent = JSON.parse((createPost![1] as RequestInit).body as string)
    // Composed to ISO 8601 UTC (local 2026-06-26T12:00 → toISOString()).
    expect(sent.occurredStart).toBe(new Date('2026-06-26T12:00:00').toISOString())
  })

  it('closes on Escape', async () => {
    openNewEventDrawer({ fetchFn: mockFetch(baseRoutes()), onCreated: () => {} })
    expect(document.querySelector('.publisher-events-drawer')).not.toBeNull()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.querySelector('.publisher-events-drawer')).toBeNull()
  })

  it('does not stack a second drawer when opened again', async () => {
    openNewEventDrawer({ fetchFn: mockFetch(baseRoutes()), onCreated: () => {} })
    openNewEventDrawer({ fetchFn: mockFetch(baseRoutes()), onCreated: () => {} })
    expect(document.querySelectorAll('.publisher-events-drawer')).toHaveLength(1)
    expect(document.querySelectorAll('.publisher-events-drawer-backdrop')).toHaveLength(1)
  })

  it('blocks save (no POST) when a required field is empty', async () => {
    const fetchFn = mockFetch(baseRoutes())
    openNewEventDrawer({ fetchFn, onCreated: () => {} })
    await settle()
    // Leave title/source empty; click Save.
    const saveBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('.publisher-events-drawer-actions button'))
      .find(b => b.classList.contains('publisher-btn-primary'))!
    saveBtn.click()
    await settle()
    const createPost = fetchFn.mock.calls.find(
      c => String(c[0]).split('?')[0].endsWith('/publish/events') && (c[1] as RequestInit)?.method === 'POST',
    )
    expect(createPost).toBeUndefined()
    // Drawer stays open for correction.
    expect(document.querySelector('.publisher-events-drawer')).not.toBeNull()
  })
})
