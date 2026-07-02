/**
 * Shared types + pure helpers for the Events-tab redesign
 * (`docs/events-tab-handoff/EVENTS_TAB_IMPLEMENTATION_BRIEF.md`). The
 * wire shapes mirror `GET /api/v1/publish/events` (each event via
 * `toPublicEvent`, so `geometry` + `categories` + `keywords` are already
 * present); the helpers are framework-free so the queue/detail
 * components and tests can share them.
 */

import { toDisplayScore } from './match-badge'

export type EventStatus = 'proposed' | 'approved' | 'rejected' | 'expired'
export type LinkStatus = 'proposed' | 'approved' | 'rejected'

/** Per-signal match breakdown (0–1 each, or null). "Topic" = lexical. */
export interface LinkSignals {
  geo?: number | null
  temporal?: number | null
  lexical?: number | null
  semantic?: number | null
}

export interface ReviewLink {
  datasetId: string
  datasetTitle: string | null
  score: number | null
  signals: LinkSignals | null
  status: LinkStatus
}

export interface EventGeometry {
  boundingBox?: { n: number; s: number; w: number; e: number }
  point?: { lat: number; lon: number }
  regionName?: string
}

/** The provenance vocabulary of the slice-C enrichment — which event
 *  fields the ingest layer can AI-infer (`events-enrich.ts`). */
export type InferredField = 'occurredStart' | 'geometry'

export interface ReviewEvent {
  id: string
  title: string
  summary?: string
  source: { name: string; url: string; publishedAt?: string }
  occurredStart?: string
  occurredEnd?: string
  status: EventStatus
  geometry?: EventGeometry
  /** Facet group → values, e.g. `{ "Wildfires": ["Fire"] }`. */
  categories?: Record<string, string[]>
  keywords?: string[]
  /** Fields the ingest layer AI-inferred — the detail pane badges these
   *  so the curator double-checks them before approving (feeds slice C).
   *  Mirrors the backend's `InferredField` provenance vocabulary. */
  inferredFields?: InferredField[]
  links: ReviewLink[]
}

export interface EventsResponse {
  events: ReviewEvent[]
}

/**
 * Composite match ≥ this percent (display scale) is auto-suggested as
 * paired when the curator approves the event; the rest stay "suggested"
 * for a manual look. Single named constant per the brief §5.
 */
export const AUTO_PAIR_THRESHOLD = 90

/** Composite match for a link on the display 0–100 scale (or null). */
export function compositePercent(link: ReviewLink): number | null {
  return toDisplayScore(link.score)
}

/**
 * The dataset ids that "Approve all ≥90%" should pair: still-proposed
 * links whose composite clears {@link AUTO_PAIR_THRESHOLD}. Already
 * approved/rejected links are left as-is; null-composite links never
 * auto-pair (a human decides).
 */
export function autoPairTargets(
  event: Pick<ReviewEvent, 'links'>,
  threshold: number = AUTO_PAIR_THRESHOLD,
): string[] {
  return event.links
    .filter(l => l.status === 'proposed')
    // Compare the RAW 0–1 score against the threshold, not the rounded
    // display percent — an approval shortcut must be conservative, so a
    // link at 0.895 (rounds to 90) stays below a 90% threshold.
    .filter(l => l.score != null && Number.isFinite(l.score) && l.score >= threshold / 100)
    .map(l => l.datasetId)
}

/**
 * A single lat/lon to centre the locator map on: the event's point, or
 * the centre of its bounding box. Region-only (or geometry-less) events
 * return null — the locator is hidden rather than faked.
 */
export function locatorPoint(geometry: EventGeometry | undefined): { lat: number; lon: number } | null {
  if (!geometry) return null
  if (geometry.point) return geometry.point
  if (geometry.boundingBox) {
    const { n, s, w, e } = geometry.boundingBox
    return { lat: (n + s) / 2, lon: (w + e) / 2 }
  }
  return null
}

/** The event's primary category value (drives the leading glyph / dot),
 *  or null when uncategorised. Takes the first value of the first
 *  facet group, matching how the queue surfaces one category word. */
export function primaryCategory(event: Pick<ReviewEvent, 'categories'>): string | null {
  const cats = event.categories
  if (!cats) return null
  for (const values of Object.values(cats)) {
    if (values && values.length > 0) return values[0]
  }
  return null
}
