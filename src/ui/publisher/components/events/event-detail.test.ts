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
