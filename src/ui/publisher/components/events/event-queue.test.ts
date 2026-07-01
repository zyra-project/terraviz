import { describe, it, expect, vi } from 'vitest'
import { renderEventQueue } from './event-queue'
import type { ReviewEvent, ReviewLink } from './events-model'

function link(datasetId: string, status: ReviewLink['status']): ReviewLink {
  return { datasetId, datasetTitle: datasetId, score: 0.9, signals: { lexical: 0.9 }, status }
}

function event(overrides: Partial<ReviewEvent> = {}): ReviewEvent {
  return {
    id: 'EVT1',
    title: 'Hurricane makes landfall',
    source: { name: 'NOAA', url: 'https://example.gov/x' },
    status: 'proposed',
    links: [],
    ...overrides,
  }
}

describe('renderEventQueue', () => {
  it('counts only still-proposed links in the "to review" sub-line', () => {
    const evt = event({ links: [link('DS1', 'proposed'), link('DS2', 'approved'), link('DS3', 'rejected')] })
    const nav = renderEventQueue([evt], 'EVT1', { onSelect: vi.fn() })
    // 3 links, but only 1 still awaits a decision.
    expect(nav.querySelector('.publisher-events-queue-sub')?.textContent).toContain('1')
    expect(nav.querySelector('.publisher-events-queue-sub')?.textContent).not.toContain('3')
  })

  it('uses the supplied eyebrow label for the active filter', () => {
    const nav = renderEventQueue([event()], 'EVT1', { onSelect: vi.fn() }, 'Approved')
    expect(nav.querySelector('.publisher-events-eyebrow')?.textContent).toBe('Approved')
  })

  it('fires onSelect with the row id when clicked', () => {
    const onSelect = vi.fn()
    const nav = renderEventQueue([event()], null, { onSelect })
    ;(nav.querySelector('.publisher-events-queue-row') as HTMLButtonElement).click()
    expect(onSelect).toHaveBeenCalledWith('EVT1')
  })
})
