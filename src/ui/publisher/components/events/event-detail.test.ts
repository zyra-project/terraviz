import { describe, it, expect, vi } from 'vitest'
import { renderEventDetail } from './event-detail'
import type { ReviewEvent, ReviewLink } from './events-model'

function okFetch() {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    type: 'basic',
    json: async () => ({ event: null, links: [] }),
    text: async () => '{}',
  }) as unknown as Response)
}

function link(datasetId: string): ReviewLink {
  return { datasetId, datasetTitle: datasetId, score: 0.95, signals: { lexical: 0.95 }, status: 'proposed' }
}

const flush = () => new Promise<void>(r => setTimeout(r, 0))

function event(overrides: Partial<ReviewEvent> = {}): ReviewEvent {
  return {
    id: 'EVT1',
    title: 'Southern-hemisphere storm',
    source: { name: 'NOAA', url: 'https://example.gov/x' },
    status: 'proposed',
    links: [],
    ...overrides,
  }
}

describe('renderEventDetail — locator coordinates', () => {
  it('renders the hemisphere suffix without the numeric sign', () => {
    // A southern/western point: the suffix conveys the hemisphere, so the
    // magnitude must be shown unsigned (not "-46.4°S").
    const pane = renderEventDetail(
      event({ geometry: { point: { lat: -46.4, lon: -73.2 } } }),
      { onEventStatusChange: vi.fn() },
    )
    const coords = pane.querySelector('.publisher-events-detail-coords')?.textContent
    expect(coords).toBe('46.4°S, 73.2°W')
  })

  it('uses N/E for a northern/eastern point', () => {
    const pane = renderEventDetail(
      event({ geometry: { point: { lat: 12.5, lon: 100.1 } } }),
      { onEventStatusChange: vi.fn() },
    )
    expect(pane.querySelector('.publisher-events-detail-coords')?.textContent).toBe('12.5°N, 100.1°E')
  })
})

/** A fetch mock that serves the published-datasets list for the "+ Add
 *  dataset" search and accepts the review POST. */
function addFlowFetch() {
  const datasets = {
    datasets: [
      { id: 'DS_NEW', slug: 'ocean-currents', title: 'Ocean Currents', abstract: null, organization: 'NOAA', format: 'video/mp4', visibility: 'public', created_at: '', updated_at: '', published_at: '2026-01-01', retracted_at: null, publisher_id: null, legacy_id: null },
    ],
    next_cursor: null,
  }
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const method = init?.method ?? 'GET'
    const body = method === 'GET' && url.includes('/publish/datasets') ? datasets : { event: null, links: [] }
    return { ok: true, status: 200, type: 'basic', json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
  })
}

describe('renderEventDetail — add off-list dataset', () => {
  it('searches the catalog and posts addDatasetIds, appending a proposed row', async () => {
    const fetchFn = addFlowFetch()
    const onLinksChanged = vi.fn()
    const evt = event({ links: [link('DS_EXISTING')] })
    const pane = renderEventDetail(evt, { onEventStatusChange: vi.fn(), onLinksChanged, fetchFn })

    // Open the add panel → triggers the published-datasets fetch.
    ;(pane.querySelector('.publisher-events-add-btn') as HTMLButtonElement).click()
    await flush()

    const search = pane.querySelector('.publisher-events-add-panel input') as HTMLInputElement
    expect(search.disabled).toBe(false)
    search.value = 'ocean'
    search.dispatchEvent(new Event('input'))

    const candidate = pane.querySelector('.publisher-events-add-candidate button') as HTMLButtonElement
    expect(candidate).toBeTruthy()
    candidate.click()
    await flush()

    const post = fetchFn.mock.calls.find(c => (c[1] as RequestInit)?.method === 'POST')
    expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({ addDatasetIds: ['DS_NEW'] })
    // The new pairing is reflected locally + the queue is asked to refresh.
    expect(evt.links.some(l => l.datasetId === 'DS_NEW' && l.status === 'proposed')).toBe(true)
    expect(onLinksChanged).toHaveBeenCalled()
  })

  it('excludes already-linked datasets from the candidate list', async () => {
    const fetchFn = addFlowFetch()
    const evt = event({ links: [link('DS_NEW')] }) // DS_NEW already paired
    const pane = renderEventDetail(evt, { onEventStatusChange: vi.fn(), fetchFn })
    ;(pane.querySelector('.publisher-events-add-btn') as HTMLButtonElement).click()
    await flush()
    const search = pane.querySelector('.publisher-events-add-panel input') as HTMLInputElement
    search.value = 'ocean'
    search.dispatchEvent(new Event('input'))
    expect(pane.querySelector('.publisher-events-add-candidate')).toBeNull()
  })
})

describe('renderEventDetail — onLinksChanged', () => {
  it('fires after a per-link decision so the queue count can refresh', async () => {
    const onLinksChanged = vi.fn()
    const pane = renderEventDetail(
      event({ links: [link('DS1')] }),
      { onEventStatusChange: vi.fn(), onLinksChanged, fetchFn: okFetch() },
    )
    ;(pane.querySelector('.publisher-events-pairing .publisher-events-icon-btn-approve') as HTMLButtonElement).click()
    await flush()
    expect(onLinksChanged).toHaveBeenCalled()
  })
})

describe('renderEventDetail — AI-inferred badge (slice C)', () => {
  it('badges inferred fields with readable names', () => {
    const pane = renderEventDetail(
      event({ inferredFields: ['occurredStart', 'geometry'] }),
      { onEventStatusChange: vi.fn() },
    )
    const badge = pane.querySelector('.publisher-events-inferred-badge')
    expect(badge?.textContent).toBe('date, location')
    expect(badge?.getAttribute('title')).toBeTruthy()
  })

  it('renders no badge when nothing was inferred', () => {
    const pane = renderEventDetail(event(), { onEventStatusChange: vi.fn() })
    expect(pane.querySelector('.publisher-events-inferred-badge')).toBeNull()
  })
})

describe('renderEventDetail — curator metadata override', () => {
  it('save posts { edits } with only the changed fields and updates the event', async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      type: 'basic',
      json: async () => ({
        event: {
          occurredStart: '2026-06-18T00:00:00.000Z',
          geometry: { boundingBox: { n: 30, s: 8, w: -90, e: -58 }, regionName: 'Caribbean Sea' },
        },
        links: [],
      }),
      text: async () => '{}',
    }) as unknown as Response)
    const evt = event({
      occurredStart: '2026-06-20T00:00:00.000Z',
      inferredFields: ['geometry'],
      geometry: { regionName: 'Europe' },
    })
    const onEventStatusChange = vi.fn()
    const pane = renderEventDetail(evt, { onEventStatusChange, fetchFn })

    const toggle = pane.querySelector('.publisher-events-edit-toggle') as HTMLButtonElement
    toggle.click()
    const form = pane.querySelector('.publisher-events-edit-form') as HTMLElement
    expect(form.hidden).toBe(false)

    const [dateInput, regionInput] = [...form.querySelectorAll('input')]
    expect(dateInput.value).toBe('2026-06-20') // prefilled
    regionInput.value = 'Caribbean'
    ;(form.querySelector('button') as HTMLButtonElement).click()
    await flush()

    const body = JSON.parse(String(fetchFn.mock.calls[0][1]!.body)) as { edits: Record<string, string> }
    expect(body.edits).toEqual({ regionName: 'Caribbean' }) // date unchanged → omitted
    // In-memory event reflects the server's resolved values; the
    // orchestrator is asked to re-render.
    expect(evt.geometry?.regionName).toBe('Caribbean Sea')
    expect(evt.inferredFields).toBeUndefined()
    expect(onEventStatusChange).toHaveBeenCalledWith('EVT1', 'proposed')
  })

  it('offers the region vocabulary as a datalist', () => {
    const pane = renderEventDetail(event(), { onEventStatusChange: vi.fn() })
    const options = pane.querySelectorAll('datalist option')
    expect(options.length).toBeGreaterThan(50)
  })
})

describe('renderEventDetail — coordinate override', () => {
  it('posts a parsed point and rejects malformed input client-side', async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      type: 'basic',
      json: async () => ({ event: {}, links: [] }),
      text: async () => '{}',
    }) as unknown as Response)
    const pane = renderEventDetail(event(), { onEventStatusChange: vi.fn(), fetchFn })
    ;(pane.querySelector('.publisher-events-edit-toggle') as HTMLButtonElement).click()
    const form = pane.querySelector('.publisher-events-edit-form') as HTMLElement
    const inputs = [...form.querySelectorAll('input')]
    const pointInput = inputs[2]
    const save = form.querySelector('button') as HTMLButtonElement

    // Malformed → client-side error, no POST.
    pointInput.value = 'not coords'
    save.click()
    await flush()
    expect(fetchFn).not.toHaveBeenCalled()
    expect(form.querySelector('.publisher-events-edit-status')?.textContent).toBeTruthy()

    pointInput.value = '37.2, -76.8'
    save.click()
    await flush()
    const body = JSON.parse(String(fetchFn.mock.calls[0][1]!.body)) as { edits: { point: unknown } }
    expect(body.edits.point).toEqual({ lat: 37.2, lon: -76.8 })
  })
})

describe('renderEventDetail — generate tour', () => {
  it('POSTs to /tour and navigates into the authoring dock on success', async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 201,
      type: 'basic',
      json: async () => ({ tour: { id: '01HXTOUR', slug: 'event-tour', title: 'Event: Storm' } }),
      text: async () => '{}',
    }) as unknown as Response)
    const navigate = vi.fn()
    const pane = renderEventDetail(event({ links: [link('DS1')] }), {
      onEventStatusChange: vi.fn(),
      fetchFn,
      navigate,
    })
    ;(pane.querySelector('.publisher-events-tour-btn') as HTMLButtonElement).click()
    await flush()
    const [url, init] = fetchFn.mock.calls[0]
    expect(String(url)).toBe('/api/v1/publish/events/EVT1/tour')
    expect((init as RequestInit).method).toBe('POST')
    expect(navigate).toHaveBeenCalledWith('/?tourEdit=01HXTOUR')
  })

  it('surfaces the server message when the event has no stops', async () => {
    const body = {
      error: 'no_datasets',
      errors: [{ field: 'links', code: 'no_datasets', message: 'No visible dataset pairings.' }],
    }
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: false,
      status: 400,
      type: 'basic',
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response)
    const navigate = vi.fn()
    const pane = renderEventDetail(event(), { onEventStatusChange: vi.fn(), fetchFn, navigate })
    const btn = pane.querySelector('.publisher-events-tour-btn') as HTMLButtonElement
    btn.click()
    await flush()
    expect(navigate).not.toHaveBeenCalled()
    expect(btn.disabled).toBe(false)
    const status = pane.querySelector('.publisher-events-tour-status') as HTMLElement
    expect(status.textContent).toBe('No visible dataset pairings.')
    expect(status.classList.contains('publisher-events-status-error')).toBe(true)
  })
})
