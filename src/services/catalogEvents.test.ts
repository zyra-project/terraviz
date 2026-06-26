import { describe, it, expect } from 'vitest'
import { buildCatalogEvents } from './catalogEvents'
import type { PublicEvent } from './eventsService'

function ev(id: string, datasetIds: string[]): PublicEvent {
  return {
    id,
    title: `Event ${id}`,
    source: { name: 'NOAA', url: 'https://example.gov/x' },
    geometry: { point: { lat: 0, lon: 0 } },
    datasetIds,
  }
}

describe('buildCatalogEvents', () => {
  it('keeps events with a visible linked dataset, narrowing the links to visible ones', () => {
    const events = [ev('E1', ['DS0', 'DS_HIDDEN'])]
    const { overlays } = buildCatalogEvents(events, new Set(['DS0']))
    expect(overlays).toHaveLength(1)
    expect(overlays[0].eventId).toBe('E1')
    expect(overlays[0].linkedDatasetIds).toEqual(['DS0']) // DS_HIDDEN filtered out
  })

  it('drops an event whose links are all currently hidden/filtered', () => {
    const events = [ev('E1', ['DS_HIDDEN'])]
    const { overlays } = buildCatalogEvents(events, new Set(['DS0']))
    expect(overlays).toEqual([])
  })

  it('returns no overlays for an empty event list', () => {
    expect(buildCatalogEvents([], new Set(['DS0'])).overlays).toEqual([])
  })
})
