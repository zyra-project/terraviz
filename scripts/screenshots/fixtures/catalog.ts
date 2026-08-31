// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Catalog API fixtures for the smoke tests.
 *
 * The catalog browse surface (`/?catalog=true`) boots from this
 * deployment's `/api/v1/catalog` (+ `/api/v1/tours`). On a CI dev
 * server there is no Pages Functions backend, so those paths return the
 * bundled `index.html` — HTML that fails JSON parse, leaving the
 * catalog empty and `#browse-overlay` hidden. The smoke catalog checks
 * then race a never-arriving grid against the 30s locator timeout and
 * flake.
 *
 * Stubbing the two endpoints makes the browse overlay populate
 * deterministically. Two of the four datasets carry "Ocean" in the
 * title so the search-narrowing assertion (search "ocean" → strictly
 * fewer cards) is stable. See `docs/VISUAL_REPORT_PLAN.md`.
 */

import type { FixtureRule } from '../core/fixtures'
// Type-only import — erased at runtime, so no SPA runtime code (i18n,
// logger) is pulled into the node capture scripts.
import type { PublicEvent } from '../../../src/services/eventsService'

/** Minimal subset of the `/api/v1/catalog` wire shape the SPA consumes.
 *
 *  `format` must be one of `dataService`'s supported types — the browse
 *  list runs every row through `isSupportedDataset`, and a row whose
 *  format is not recognised is dropped silently. These fixtures used to
 *  say `'image'`, which is not in the set, so every dataset here was
 *  filtered out and the catalog scenes rendered only the two builtin
 *  tour cards. Nothing caught it because no scene asserted on a dataset
 *  card, and the smoke test's "search narrows the list" check passed
 *  vacuously against a list that was already tours-only. */
interface WireDatasetFixture {
  id: string
  title: string
  format: string
  dataLink: string
  organization?: string
  abstractTxt?: string
  tags?: string[]
  boundingBox?: { n: number; s: number; w: number; e: number }
  /** Data-encoded rows only. The colorbar renders from the sidecar
   *  alone, so a fixture needs the scale but not genuinely luma-encoded
   *  pixels — the sample PNG stands in for the frame. */
  renderEncoding?: string
  colorScale?: {
    stops: { t: number; rgba: [number, number, number, number] }[]
    vmin: number
    vmax: number
    units?: string
    transparentRange?: number
  }
}

const WORLDWIDE = { n: 90, s: -90, w: -180, e: 180 }

const DATASETS: WireDatasetFixture[] = [
  {
    id: 'INTERNAL_OCEAN_SST',
    title: 'Ocean Surface Temperature',
    format: 'image/png',
    dataLink: '/assets/equirect-sample.png',
    organization: 'NOAA',
    abstractTxt: 'Sea surface temperature across the global ocean.',
    tags: ['Ocean'],
    boundingBox: WORLDWIDE,
  },
  {
    id: 'INTERNAL_OCEAN_CURRENTS',
    title: 'Ocean Surface Currents',
    format: 'image/png',
    dataLink: '/assets/equirect-sample.png',
    organization: 'NOAA',
    abstractTxt: 'Surface currents across the world ocean.',
    tags: ['Ocean'],
    boundingBox: WORLDWIDE,
  },
  {
    id: 'INTERNAL_ATMO_CO2',
    title: 'Atmospheric Carbon Dioxide',
    format: 'image/png',
    dataLink: '/assets/equirect-sample.png',
    organization: 'NASA',
    abstractTxt: 'Global atmospheric carbon dioxide concentration.',
    tags: ['Atmosphere'],
    boundingBox: WORLDWIDE,
  },
  {
    // The data-encoded row, mirroring the shipped RRFS smoke rows:
    // a regional North America bbox, kg m-2 at 5e-4 full scale, and the
    // 12/256 transparent band. Drives the colorbar scenes.
    id: 'INTERNAL_SMOKE_COLUMN',
    title: 'Wildfire Smoke Overhead',
    format: 'image/png',
    dataLink: '/assets/equirect-sample.png',
    organization: 'NOAA',
    abstractTxt: 'Vertically integrated smoke, data-encoded so the globe reports values.',
    tags: ['Atmosphere'],
    boundingBox: { n: 85, s: 5, w: -175, e: -20 },
    renderEncoding: 'data-luma',
    colorScale: {
      stops: [
        { t: 0, rgba: [255, 255, 229, 0] },
        { t: 0.5, rgba: [254, 153, 41, 128] },
        { t: 1, rgba: [102, 37, 6, 255] },
      ],
      vmin: 0,
      vmax: 0.0005,
      units: 'kg m-2',
      transparentRange: 0.046875,
    },
  },
  {
    id: 'INTERNAL_LAND_NDVI',
    title: 'Vegetation Index',
    format: 'image/png',
    dataLink: '/assets/equirect-sample.png',
    organization: 'NASA',
    abstractTxt: 'Land vegetation greenness from satellite.',
    tags: ['Land'],
    boundingBox: WORLDWIDE,
  },
]

/** Route-stub rules for the catalog + tours endpoints. */
export function catalogFixtures(): FixtureRule[] {
  return [
    { url: '/api/v1/catalog', json: { datasets: DATASETS } },
    { url: '/api/v1/tours', json: { tours: [] } },
  ]
}

/** One approved current event linked to a fixture dataset — typed
 *  against the SPA's own wire shape so drift is caught at type-check,
 *  and the catalog Map / Timeline event overlays render (and diff)
 *  deterministically. */
const EVENT: PublicEvent = {
  id: '01HFIXTUREEVENT000000001',
  title: 'Marine heatwave develops in the North Pacific',
  summary: 'Sea surface temperatures are running well above average across the basin.',
  source: { name: 'Example Science Desk', url: 'https://news.example.org/heatwave', publishedAt: '2026-06-20T12:00:00.000Z' },
  occurredStart: '2026-06-18T00:00:00.000Z',
  geometry: { point: { lat: 40, lon: -150 } },
  datasetIds: ['INTERNAL_OCEAN_SST'],
}

/**
 * The full fixture set for **visual-report** SPA scenes.
 *
 * The catalog scenes used to capture the *live* production catalog
 * (the dev server proxies `/api` upstream), so every content change or
 * slow thumbnail diffed against the baseline — the report's residual
 * churn after the globe backdrop was stabilised. This pins every
 * content endpoint the SPA reads on boot; the trailing catch-all lets
 * everything else (the GIBS tile proxy, telemetry ingest) through so
 * those behave exactly as before.
 */
export function catalogReportFixtures(): FixtureRule[] {
  return [
    ...catalogFixtures(),
    { url: '/api/v1/featured-event', json: { event: null } },
    // The hero's operator-override read (`heroService.backendUrl()`) —
    // `{ hero: null }` is the endpoint's documented no-override shape.
    { url: '/api/v1/featured-hero', json: { hero: null } },
    { url: '/api/v1/events', json: { events: [EVENT] } },
    // Orbit settings' model dropdown — a fixed list, not the live
    // provider's.
    { url: '/api/models', json: { data: [{ id: 'llama-3.1-70b' }] } },
    // The info panel's semantic "more like this" read, which fires
    // whenever a dataset is loaded. Unstubbed it 404s and the scene
    // reports a console error for what is really the documented
    // degrade-to-lexical path. `degraded: true` is the endpoint's own
    // way of saying "use the lexical list", so the panel behaves
    // exactly as it does against a backend without embeddings.
    { url: '/related', json: { datasets: [], degraded: true } },
    { url: '/api/', passthrough: true },
  ]
}
