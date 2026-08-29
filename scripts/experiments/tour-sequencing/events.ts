// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Draft events for the sequencing experiment.
 *
 * Archetypes chosen to span the geometry and topic space a real
 * newsroom queue produces: a point hazard, a regional hazard, a
 * slow-onset regional story, a polar story, a global story, and one
 * with no geometry at all (the case that makes `scoreGeo` return null).
 *
 * Text is written the way a wire headline reads, because
 * `buildEventTerms` tokenises exactly that.
 */

import { buildEventTerms, type MatchEvent } from '../../../functions/api/v1/_lib/events-matcher'

export interface DraftEvent {
  key: string
  title: string
  summary: string
  archetype: string
  match: MatchEvent
}

interface Spec {
  key: string
  archetype: string
  title: string
  summary: string
  point?: { lat: number; lon: number }
  bbox?: { n: number; s: number; w: number; e: number }
  occurredStart?: string
  occurredEnd?: string
}

const SPECS: readonly Spec[] = [
  {
    key: 'hurricane',
    archetype: 'point hazard — tropical cyclone',
    title: 'Hurricane Delta strengthens to Category 4 in the Gulf',
    summary:
      'Delta intensified overnight with sustained winds near 130 mph as it moved toward the northern Gulf coast. Storm surge and heavy rainfall are expected along the coastline.',
    point: { lat: 25.5, lon: -90.2 },
    occurredStart: '2026-08-20T12:00:00.000Z',
  },
  {
    key: 'wildfire',
    archetype: 'point hazard — wildfire and smoke',
    title: 'Wildfire smoke blankets the northern Rockies',
    summary:
      'Smoke from fires burning across Idaho and Montana pushed air quality into unhealthy ranges, with aerosol plumes visible from orbit across several states.',
    point: { lat: 46.2, lon: -113.5 },
    occurredStart: '2026-08-18T00:00:00.000Z',
  },
  {
    key: 'quake',
    archetype: 'point hazard — earthquake',
    title: 'Magnitude 7.1 earthquake strikes off the Alaskan coast',
    summary:
      'A shallow magnitude 7.1 earthquake was recorded in the Gulf of Alaska. A tsunami advisory was briefly issued for nearby coastal communities.',
    point: { lat: 57.1, lon: -152.4 },
    occurredStart: '2026-08-22T04:12:00.000Z',
  },
  {
    key: 'drought',
    archetype: 'regional slow-onset — drought and heat',
    title: 'Exceptional drought expands across the southern Plains',
    summary:
      'Persistent heat and rainfall deficits pushed drought conditions to their widest extent in a decade, stressing soil moisture, reservoirs and agriculture.',
    bbox: { n: 37, s: 28, w: -104, e: -94 },
    occurredStart: '2026-06-01T00:00:00.000Z',
    occurredEnd: '2026-08-25T00:00:00.000Z',
  },
  {
    key: 'seaice',
    archetype: 'polar — cryosphere',
    title: 'Arctic sea ice nears its annual minimum extent',
    summary:
      'Sea ice extent tracked near record lows for the date as melt continued across the Beaufort and Chukchi seas ahead of the September minimum.',
    bbox: { n: 90, s: 66, w: -180, e: 180 },
    occurredStart: '2026-08-15T00:00:00.000Z',
  },
  {
    key: 'coral',
    archetype: 'regional marine — ocean heat',
    title: 'Marine heatwave triggers widespread coral bleaching alerts',
    summary:
      'Sea surface temperatures well above the seasonal average pushed reef systems into bleaching alert levels across the Coral Sea and western Pacific.',
    bbox: { n: -10, s: -25, w: 145, e: 165 },
    occurredStart: '2026-02-01T00:00:00.000Z',
    occurredEnd: '2026-04-01T00:00:00.000Z',
  },
  {
    key: 'aurora',
    archetype: 'global — space weather',
    title: 'Severe geomagnetic storm brings aurora to mid-latitudes',
    summary:
      'A coronal mass ejection produced a severe geomagnetic storm, with aurora reported far south of their usual range and effects on satellite operations.',
    occurredStart: '2026-05-10T00:00:00.000Z',
  },
  {
    key: 'nogeo',
    archetype: 'no geometry — the null-geo path',
    title: 'Global carbon dioxide concentration passes a new milestone',
    summary:
      'Atmospheric carbon dioxide reached a new record in the annual record, continuing a decades-long rise measured at observatories worldwide.',
    occurredStart: '2026-07-01T00:00:00.000Z',
  },
]

export const DRAFT_EVENTS: readonly DraftEvent[] = SPECS.map(s => ({
  key: s.key,
  title: s.title,
  summary: s.summary,
  archetype: s.archetype,
  match: {
    point: s.point ?? null,
    boundingBox: s.bbox ?? null,
    occurredStart: s.occurredStart ?? null,
    occurredEnd: s.occurredEnd ?? null,
    terms: buildEventTerms({ title: s.title, summary: s.summary }),
  },
}))
