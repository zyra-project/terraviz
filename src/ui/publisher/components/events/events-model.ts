// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

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
  /** The story's lead image (feed enclosure / og:image) — shown in the
   *  detail pane so the curator vets it with the event. */
  imageUrl?: string
  /** Alt text for `imageUrl` (media accessibility) — curator-supplied
   *  on upload / suggestion pick. */
  imageAlt?: string
  /** Curator-picked agency video embed (youtube-nocookie/embed) — the
   *  generated tour frames it; independent of the story image. */
  videoEmbedUrl?: string
  /** Curator-picked DIRECT video file (non-YouTube agency MP4) — the
   *  generated tour plays it natively via the media-proxy. Mutually
   *  exclusive with `videoEmbedUrl` in practice (an event has one video). */
  videoFileUrl?: string
  links: ReviewLink[]
  /** Whether the caller may review/edit this event: its owner (with
   *  `content.edit.own`), or an `content.edit.any` holder
   *  (editor / admin / service) — the latter also covers as-yet-unclaimed
   *  events (`owner_id === null`), which are editable only at the `.any`
   *  tier, not by any active publisher. Absent (older payload / fixture)
   *  is treated as editable; the server is the authoritative gate. */
  can_edit?: boolean
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
 * A dataset title with a trailing climate-scenario qualifier removed, or
 * null when it has none.
 *
 * Scenario variants of one field — `Climate Model - Sea Ice
 * Concentration: SSP1 (Low)` / `SSP2 (Moderate)` / `SSP5 (Very High)` —
 * are the same globe three times to a viewer. They also score
 * identically against an event, so they clear any threshold together.
 *
 * Deliberately narrow. Grouping on the text before a colon would be
 * catalogue-agnostic and wrong: it collapses `Tsunami Historical
 * Series: Chile - 1960` with `… Japan - 2011`, which are eight distinct
 * events a curator may well want individually. Nothing lexical
 * separates "same field, different scenario" from "same series,
 * different event" — only the scenario vocabulary does, so that is what
 * this matches. Against the live 180-row catalogue it groups exactly
 * the 12 SSP datasets into 4 families and leaves everything else alone.
 */
export function scenarioFamily(title: string | null | undefined): string | null {
  if (!title) return null
  const stem = title.replace(SCENARIO_SUFFIX, '')
  if (stem === title) return null
  const trimmed = stem.replace(/[\s:\-–—]+$/, '').trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Trailing `SSP2 (Moderate)` / `RCP8.5` and the separator before it. */
const SCENARIO_SUFFIX = /[\s:\-–—]*\b(?:SSP|RCP)\s*\d+(?:\.\d+)?\b(?:\s*\([^)]*\))?\s*$/i

/**
 * The dataset ids that "Approve all ≥90%" should pair: still-proposed
 * links whose composite clears {@link AUTO_PAIR_THRESHOLD}. Already
 * approved/rejected links are left as-is; null-composite links never
 * auto-pair (a human decides).
 *
 * At most one scenario variant per family is returned — the
 * highest-scoring, ties broken on dataset id so the choice is stable.
 * Measured against 118 real NASA EONET events, 36 of the 45 links this
 * shortcut would pair were three SSP siblings clearing together on 12
 * sea-ice events, so one click paired three near-identical projections
 * of one field. The others stay `proposed` rather than being rejected:
 * a curator who wants a second scenario can still pair it by hand. The
 * shortcut gets more conservative; nobody loses a choice.
 */
export function autoPairTargets(
  event: Pick<ReviewEvent, 'links'>,
  threshold: number = AUTO_PAIR_THRESHOLD,
): string[] {
  const eligible = event.links
    .filter(l => l.status === 'proposed')
    // Compare the RAW 0–1 score against the threshold, not the rounded
    // display percent — an approval shortcut must be conservative, so a
    // link at 0.895 (rounds to 90) stays below a 90% threshold.
    .filter(l => l.score != null && Number.isFinite(l.score) && l.score >= threshold / 100)

  const bestOfFamily = new Map<string, ReviewLink>()
  for (const link of eligible) {
    const family = scenarioFamily(link.datasetTitle)
    if (family === null) continue
    const held = bestOfFamily.get(family)
    if (
      !held ||
      (link.score ?? 0) > (held.score ?? 0) ||
      ((link.score ?? 0) === (held.score ?? 0) && link.datasetId < held.datasetId)
    ) {
      bestOfFamily.set(family, link)
    }
  }

  return eligible
    .filter(l => {
      const family = scenarioFamily(l.datasetTitle)
      return family === null || bestOfFamily.get(family) === l
    })
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
