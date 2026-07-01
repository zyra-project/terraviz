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
