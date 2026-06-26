/**
 * Catalog **events** view — pure transform from the public approved
 * events + the currently-visible dataset set to the overlay model the
 * catalog Map and Timeline views render
 * (`docs/CURRENT_EVENTS_PLAN.md` §6.3). Sibling of `catalogMap.ts` /
 * `catalogTimeline.ts`.
 *
 * An event is kept only if it links to a dataset that is currently
 * visible (passes the catalog's filters), so filtering the catalog
 * naturally filters the events too, and every overlay has a dataset to
 * click through to. Pure — no DOM / network.
 */

import type { PublicEvent, EventGeometry } from './eventsService'

/** One event overlay both the Map and Timeline views consume. */
export interface EventOverlay {
  eventId: string
  title: string
  source: { name: string; url: string; publishedAt?: string }
  occurredStart?: string
  occurredEnd?: string
  geometry: EventGeometry
  /** The event's visible linked datasets; the first is the primary
   *  click-through target. Always non-empty (an event with no visible
   *  link is dropped). */
  linkedDatasetIds: string[]
}

export interface CatalogEvents {
  overlays: EventOverlay[]
}

/**
 * Build the event overlays for the catalog views. `visibleDatasetIds`
 * is the set of dataset ids currently passing the catalog filters; an
 * event's `linkedDatasetIds` are narrowed to that set, and an event with
 * no visible link is dropped entirely.
 */
export function buildCatalogEvents(
  events: readonly PublicEvent[],
  visibleDatasetIds: ReadonlySet<string>,
): CatalogEvents {
  const overlays: EventOverlay[] = []
  for (const ev of events) {
    const linkedDatasetIds = ev.datasetIds.filter(id => visibleDatasetIds.has(id))
    if (linkedDatasetIds.length === 0) continue
    overlays.push({
      eventId: ev.id,
      title: ev.title,
      source: ev.source,
      occurredStart: ev.occurredStart,
      occurredEnd: ev.occurredEnd,
      geometry: ev.geometry,
      linkedDatasetIds,
    })
  }
  return { overlays }
}
